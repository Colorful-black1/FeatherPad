import { files } from '../../bridge/files';
import { externalFiles } from '../../bridge/external';
import type { DiskRevision, DocumentId, ResultEnvelope, SaveAck, SaveAsAck, SaveRequest } from '../../shared/contracts/files';
import { documents, type CapturedSaveAs, type DocumentRegistry } from './documents';

type SaveTransport = (request: SaveRequest) => Promise<ResultEnvelope<SaveAck>>;

export class SaveCoordinator {
  private readonly pending = new Map<DocumentId, Promise<ResultEnvelope<unknown>>>();
  private readonly uncertain = new Set<DocumentId>();
  private readonly uncertainDestinations = new Map<DocumentId, CapturedSaveAs>();
  private readonly uncertainOverwrites = new Map<DocumentId, { captured: CapturedSaveAs; request: SaveRequest }>();

  constructor(private readonly registry: DocumentRegistry, private readonly transport: SaveTransport = files.save,
    private readonly stat: typeof files.stat = files.stat, private readonly destinationTransport: typeof files.saveAs = files.saveAs,
    private readonly overwriteTransport: SaveTransport = externalFiles.overwrite,
    private readonly backgroundTransport: SaveTransport = files.autoSave) {}

  save(id: DocumentId): Promise<ResultEnvelope<SaveAck>> {
    return this.enqueue(id, () => this.perform(id));
  }

  autoSave(id: DocumentId, allowed: () => boolean = () => true): Promise<ResultEnvelope<SaveAck | null>> {
    return this.enqueue<SaveAck | null>(id, async () => {
      const document = this.registry.getDocument(id);
      if (!allowed() || !document?.source || !document.summary.dirty || document.summary.missing || document.fragment
        || document.summary.readOnlyReason || document.summary.closing || document.summary.hotExitFrozen
        || document.releaseUncertain) return { ok: true, value: null };
      if (this.uncertain.has(id) || this.uncertainDestinations.has(id) || this.uncertainOverwrites.has(id)) {
        return { ok: false, error: { code: 'CONFLICT', message: '先前保存结果尚未确认，请手动保存并核对磁盘。', retryable: false } };
      }
      const captured = this.registry.captureSave(id);
      if (!captured.ok) return captured;
      try {
        const result = await this.backgroundTransport(captured.value.request);
        if (!result.ok) {
          if (result.error.code === 'IPC_UNAVAILABLE') this.uncertain.add(id);
          return result;
        }
        const applied = this.registry.acknowledgeSave(captured.value, result.value);
        if (!applied.ok) { this.uncertain.add(id); return applied; }
        return result;
      } catch {
        this.uncertain.add(id);
        return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '自动保存结果未确认，正文仍保留；请手动保存并核对磁盘。', retryable: false } };
      }
    });
  }

  saveAs(id: DocumentId, intent: 'save-as' | 'copy' = 'save-as'): Promise<ResultEnvelope<SaveAsAck>> {
    return this.enqueue(id, () => this.performDestination(id, intent));
  }

  overwrite(id: DocumentId, revision: DiskRevision): Promise<ResultEnvelope<SaveAck>> {
    return this.enqueue(id, async () => {
      const pending = this.uncertainOverwrites.get(id);
      if (pending) return this.deliverOverwrite(id, pending);
      const captured = this.registry.captureSaveAs(id, 'save-as');
      if (!captured.ok) return captured;
      if (!captured.value.baseSource || this.uncertainDestinations.has(id)) {
        return { ok: false, error: { code: 'CONFLICT', message: '源绑定或另存结果尚未确认，请先重试另存。', retryable: false } };
      }
      return this.deliverOverwrite(id, { captured: captured.value,
        request: { documentId: id, requestId: captured.value.request.requestId,
          documentVersion: captured.value.request.documentVersion, text: captured.value.request.text,
          format: captured.value.request.format,
          ...(captured.value.request.newlineMap ? { newlineMap: captured.value.request.newlineMap } : {}),
          expectedDiskRevision: revision } });
    });
  }

  exclusive<T>(id: DocumentId, run: (save: () => Promise<ResultEnvelope<SaveAck>>) => Promise<ResultEnvelope<T>>): Promise<ResultEnvelope<T>> {
    return this.enqueue(id, () => run(() => this.perform(id)), true);
  }

  forgetClosed(id: DocumentId) {
    if (this.registry.getDocument(id)) return;
    this.uncertain.delete(id);
    this.uncertainDestinations.delete(id);
    this.uncertainOverwrites.delete(id);
  }

  private enqueue<T>(id: DocumentId, run: () => Promise<ResultEnvelope<T>>, continueAfterFailure = false): Promise<ResultEnvelope<T>> {
    const previous = this.pending.get(id);
    // Capture after the previous Ack so the next request uses its new disk revision.
    const scheduled = (previous ?? Promise.resolve(null)).then(result => result && !result.ok && !continueAfterFailure ? result : run());
    this.pending.set(id, scheduled);
    void scheduled.then(() => { if (this.pending.get(id) === scheduled) this.pending.delete(id); });
    return scheduled;
  }

  private async perform(id: DocumentId): Promise<ResultEnvelope<SaveAck>> {
    try {
      const overwrite = this.uncertainOverwrites.get(id);
      if (overwrite) {
        const resolved = await this.deliverOverwrite(id, overwrite);
        if (!resolved.ok || !this.registry.getDocument(id)?.summary.dirty) return resolved;
      }
      const pendingDestination = this.uncertainDestinations.get(id);
      if (pendingDestination) {
        const resolved = await this.deliverDestination(id, pendingDestination);
        if (!resolved.ok) return resolved;
        if (pendingDestination.request.intent !== 'copy' && !this.registry.getDocument(id)?.summary.dirty) {
          return { ok: true, value: resolved.value.ack };
        }
      }
      if (this.registry.getDocument(id)?.source === null || this.registry.getDocument(id)?.summary.missing) {
        const result = await this.performDestination(id, 'save-as');
        return result.ok ? { ok: true, value: result.value.ack } : result;
      }
      const captured = this.registry.captureSave(id);
      if (!captured.ok) return captured;
      if (this.uncertain.has(id)) {
        const disk = await this.stat(id);
        if (!disk.ok) return disk;
        if (disk.value.diskRevision !== captured.value.request.expectedDiskRevision) {
          return { ok: false, error: { code: 'CONFLICT', message: '上次保存结果未确认且磁盘已变化，请重新载入或另存；当前输入仍保留。', retryable: false } };
        }
        this.uncertain.delete(id);
      }
      const result = await this.transport(captured.value.request);
      if (!result.ok) {
        if (result.error.code === 'IPC_UNAVAILABLE') this.uncertain.add(id);
        return result;
      }
      const updated = this.registry.acknowledgeSave(captured.value, result.value);
      if (!updated.ok) return updated;
      return result;
    } catch {
      this.uncertain.add(id);
      return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '保存结果未确认，内容仍保留；重试前将核对磁盘状态。', retryable: false } };
    }
  }

  private async performDestination(id: DocumentId, intent: 'save-as' | 'copy'): Promise<ResultEnvelope<SaveAsAck>> {
    const overwrite = this.uncertainOverwrites.get(id);
    if (overwrite) {
      const resolved = await this.deliverOverwrite(id, overwrite);
      if (!resolved.ok) return resolved;
    }
    const previous = this.uncertainDestinations.get(id);
    if (previous) {
      const resolved = await this.deliverDestination(id, previous);
      if (!resolved.ok) return resolved;
    }
    const captured = this.registry.captureSaveAs(id, intent);
    if (!captured.ok) return captured;
    return this.deliverDestination(id, captured.value);
  }

  private async deliverOverwrite(id: DocumentId, pending: { captured: CapturedSaveAs; request: SaveRequest }): Promise<ResultEnvelope<SaveAck>> {
    let result: ResultEnvelope<SaveAck>;
    try { result = await this.overwriteTransport(pending.request); }
    catch { result = { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '覆盖结果未确认，正文仍保留；重试将核对同一请求。', retryable: false } }; }
    if (!result.ok) {
      if (result.error.code === 'IPC_UNAVAILABLE') this.uncertainOverwrites.set(id, pending);
      else this.uncertainOverwrites.delete(id);
      return result;
    }
    const source = this.registry.getDocument(id)?.source;
    if (!source || !pending.captured.baseSource) return { ok: false, error: { code: 'CONFLICT', message: '源文档绑定已变化，覆盖回执未应用。', retryable: false } };
    const acknowledged = this.registry.acknowledgeSaveAs(pending.captured, { documentId: id,
      ref: pending.captured.baseSource.ref, metadata: { ...source.metadata, isReadOnly: false,
        diskRevision: result.value.diskRevision, sizeBytes: result.value.sizeBytes, modifiedAt: result.value.savedAt }, ack: result.value });
    if (!acknowledged.ok) { this.uncertainOverwrites.set(id, pending); return acknowledged; }
    this.uncertainOverwrites.delete(id);
    this.uncertain.delete(id);
    return result;
  }

  private async deliverDestination(id: DocumentId, captured: CapturedSaveAs): Promise<ResultEnvelope<SaveAsAck>> {
    try {
      const result = await this.destinationTransport(captured.request);
      if (!result.ok) {
        if (result.error.code === 'IPC_UNAVAILABLE') this.uncertainDestinations.set(id, captured);
        else this.uncertainDestinations.delete(id);
        return result;
      }
      if (result.value.documentId !== id || result.value.ack.documentVersion !== captured.request.documentVersion) {
        this.uncertainDestinations.set(id, captured);
        return { ok: false, error: { code: 'CONFLICT', message: '另存回执版本不匹配，源内容仍保留。', retryable: false } };
      }
      if (captured.request.intent !== 'copy') {
        const updated = this.registry.acknowledgeSaveAs(captured, result.value);
        if (!updated.ok) return updated;
      }
      this.uncertainDestinations.delete(id);
      this.uncertain.delete(id);
      return result;
    } catch {
      this.uncertainDestinations.set(id, captured);
      return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '另存结果未确认，内容仍保留；重试时会核对同一请求。', retryable: false } };
    }
  }
}

export const saves = new SaveCoordinator(documents);

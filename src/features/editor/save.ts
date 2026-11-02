import { files } from '../../bridge/files';
import type { DocumentId, ResultEnvelope, SaveAck, SaveAsAck, SaveRequest } from '../../shared/contracts/files';
import { documents, type CapturedSaveAs, type DocumentRegistry } from './documents';

type SaveTransport = (request: SaveRequest) => Promise<ResultEnvelope<SaveAck>>;

export class SaveCoordinator {
  private readonly pending = new Map<DocumentId, Promise<ResultEnvelope<unknown>>>();
  private readonly uncertain = new Set<DocumentId>();
  private readonly uncertainDestinations = new Map<DocumentId, CapturedSaveAs>();

  constructor(private readonly registry: DocumentRegistry, private readonly transport: SaveTransport = files.save,
    private readonly stat: typeof files.stat = files.stat, private readonly destinationTransport: typeof files.saveAs = files.saveAs) {}

  save(id: DocumentId): Promise<ResultEnvelope<SaveAck>> {
    return this.enqueue(id, () => this.perform(id));
  }

  saveAs(id: DocumentId, intent: 'save-as' | 'copy' = 'save-as'): Promise<ResultEnvelope<SaveAsAck>> {
    return this.enqueue(id, () => this.performDestination(id, intent));
  }

  exclusive<T>(id: DocumentId, run: (save: () => Promise<ResultEnvelope<SaveAck>>) => Promise<ResultEnvelope<T>>): Promise<ResultEnvelope<T>> {
    return this.enqueue(id, () => run(() => this.perform(id)), true);
  }

  forgetClosed(id: DocumentId) {
    if (this.registry.getDocument(id)) return;
    this.uncertain.delete(id);
    this.uncertainDestinations.delete(id);
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
      const pendingDestination = this.uncertainDestinations.get(id);
      if (pendingDestination) {
        const resolved = await this.deliverDestination(id, pendingDestination);
        if (!resolved.ok) return resolved;
        if (pendingDestination.request.intent !== 'copy' && !this.registry.getDocument(id)?.summary.dirty) {
          return { ok: true, value: resolved.value.ack };
        }
      }
      if (this.registry.getDocument(id)?.source === null) {
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
    const previous = this.uncertainDestinations.get(id);
    if (previous) {
      const resolved = await this.deliverDestination(id, previous);
      if (!resolved.ok) return resolved;
    }
    const captured = this.registry.captureSaveAs(id, intent);
    if (!captured.ok) return captured;
    return this.deliverDestination(id, captured.value);
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

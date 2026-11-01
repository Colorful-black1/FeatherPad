import { files } from '../../bridge/files';
import type { DocumentId, ResultEnvelope, SaveAck, SaveRequest } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';

type SaveTransport = (request: SaveRequest) => Promise<ResultEnvelope<SaveAck>>;

export class SaveCoordinator {
  private readonly pending = new Map<DocumentId, Promise<ResultEnvelope<SaveAck>>>();
  private readonly uncertain = new Set<DocumentId>();

  constructor(private readonly registry: DocumentRegistry, private readonly transport: SaveTransport = files.save,
    private readonly stat: typeof files.stat = files.stat) {}

  save(id: DocumentId): Promise<ResultEnvelope<SaveAck>> {
    const previous = this.pending.get(id);
    // Capture after the previous Ack so the next request uses its new disk revision.
    const scheduled = (previous ?? Promise.resolve(null)).then(result => result && !result.ok ? result : this.perform(id));
    this.pending.set(id, scheduled);
    void scheduled.then(() => { if (this.pending.get(id) === scheduled) this.pending.delete(id); });
    return scheduled;
  }

  private async perform(id: DocumentId): Promise<ResultEnvelope<SaveAck>> {
    try {
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
}

export const saves = new SaveCoordinator(documents);

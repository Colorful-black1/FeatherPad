import { files } from '../../bridge/files';
import type { DocumentId, ResultEnvelope, SaveAck } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';
import { saves, type SaveCoordinator } from './save';

export type CloseChoice = 'clean' | 'save' | 'discard' | 'cancel';
export interface CloseResult { closed: boolean }

function changed(): ResultEnvelope<never> {
  return { ok: false, error: { code: 'CONFLICT', message: '文档已有新修改，已保留内容；请重新确认关闭。', retryable: false } };
}

export class CloseCoordinator {
  private readonly active = new Set<DocumentId>();
  constructor(private readonly registry: DocumentRegistry, private readonly saving: SaveCoordinator,
    private readonly discard: typeof files.discardRecovery = files.discardRecovery,
    private readonly release: typeof files.release = files.release) {}

  close(id: DocumentId, version: number, choice: CloseChoice): Promise<ResultEnvelope<CloseResult>> {
    if (this.active.has(id)) return Promise.resolve({ ok: false, error: {
      code: 'BUSY', message: '关闭已经开始，请等待结果后重试。', retryable: true,
    } });
    if (choice === 'cancel') return Promise.resolve({ ok: true, value: { closed: false } });
    this.active.add(id);
    return this.saving.exclusive(id, save => this.perform(id, version, choice, save))
      .finally(() => { this.active.delete(id); });
  }

  private async perform(id: DocumentId, version: number, choice: Exclude<CloseChoice, 'cancel'>,
    save: () => Promise<ResultEnvelope<SaveAck>>): Promise<ResultEnvelope<CloseResult>> {
    let document = this.registry.getDocument(id);
    if (!document) return { ok: true, value: { closed: true } };
    if (document.summary.version !== version || (choice === 'clean' && document.summary.dirty)) return changed();
    if (choice === 'save' && document.summary.dirty) {
      const result = await save();
      if (!result.ok) return result;
      document = this.registry.getDocument(id);
      if (!document || document.summary.dirty || document.summary.version !== version) return changed();
    }
    const started = this.registry.beginClose(id, version);
    if (!started.ok) return started;
    let discardedThrough: number | null = null;
    let removed = false;
    let releaseStarted = false;
    try {
      if (!document.fragment && (document.summary.dirty || version > 0 || document.hasRecoveryData)) {
        discardedThrough = version;
        const result = await this.discard({ documentId: id, throughVersion: version });
        if (!result.ok) return result;
        if (result.value.documentId !== id || result.value.throughVersion !== version || result.value.discarded !== true) return changed();
      }
      releaseStarted = true;
      const released = await this.release(id);
      if (!released.ok) {
        if (released.error.code === 'IPC_UNAVAILABLE') this.registry.retainUncertainRelease(id);
        return released;
      }
      const result = this.registry.removeClosed(id, version);
      removed = result.ok;
      if (removed) this.saving.forgetClosed(id);
      return result;
    } catch {
      if (releaseStarted) this.registry.retainUncertainRelease(id);
      return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '关闭结果尚未确认，正文仍保留，请重试。', retryable: true } };
    } finally {
      if (!removed) this.registry.cancelClose(id, discardedThrough);
    }
  }
}

export const closes = new CloseCoordinator(documents, saves);

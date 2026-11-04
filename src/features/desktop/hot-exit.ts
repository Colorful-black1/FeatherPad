import { getCurrentWindow } from '@tauri-apps/api/window';
import { files } from '../../bridge/files';
import { desktopBridge } from '../../bridge/desktop';
import type {
  DiscardRecoveryRequest, DiscardRecoveryResult, DocumentId, ResultEnvelope,
} from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from '../editor/documents';
import { recoveries, type RecoveryCoordinator } from '../editor/recovery';
import { session, type SessionCoordinator } from './session';

export interface HotExitSnapshot {
  phase: 'idle' | 'preparing' | 'failed';
  error: string | null;
  failedDocumentIds: readonly DocumentId[];
}

type RecoveryActions = Pick<RecoveryCoordinator, 'start' | 'stop' | 'flush'>;
type SessionActions = Pick<SessionCoordinator, 'start' | 'stop' | 'flush' | 'clear'>;
type DiscardRecovery = (request: DiscardRecoveryRequest) => Promise<ResultEnvelope<DiscardRecoveryResult>>;

function failed(message: string, retryable = true): ResultEnvelope<never> {
  return { ok: false, error: { code: 'PARTIAL_FAILURE', message, retryable } };
}

async function destroyWindow() {
  await getCurrentWindow().destroy();
}

export class HotExitCoordinator {
  private snapshot: HotExitSnapshot = { phase: 'idle', error: null, failedDocumentIds: [] };
  private readonly listeners = new Set<() => void>();
  private active: Promise<ResultEnvelope<{ ready: true }>> | null = null;
  private frozen = false;

  constructor(
    private readonly registry: DocumentRegistry,
    private readonly recovery: RecoveryActions,
    private readonly session: SessionActions,
    private readonly discard: DiscardRecovery = files.discardRecovery,
    private readonly destroy: () => Promise<void> = destroyWindow,
    private readonly removeWindowSession = desktopBridge.removeCurrentWindowSession,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  prepare(): Promise<ResultEnvelope<{ ready: true }>> {
    if (this.active) return this.active;
    const operation = this.prepareNow().finally(() => {
      if (this.active === operation) this.active = null;
    });
    this.active = operation;
    return operation;
  }

  async discardAndExit(): Promise<ResultEnvelope<{ ready: true }>> {
    if (this.active) return this.active;
    const operation = this.discardAndExitNow().finally(() => {
      if (this.active === operation) this.active = null;
    });
    this.active = operation;
    return operation;
  }

  resume() {
    if (!this.frozen) return;
    this.frozen = false;
    this.registry.cancelHotExit();
    this.recovery.start();
    this.session.start();
    this.publish({ phase: 'idle', error: null, failedDocumentIds: [] });
  }

  private async prepareNow(): Promise<ResultEnvelope<{ ready: true }>> {
    this.freeze();
    this.publish({ phase: 'preparing', error: null, failedDocumentIds: [] });
    const dirty = this.dirtyIds();
    const failedIds: DocumentId[] = [];
    const errors: string[] = [];
    for (const id of dirty) {
      const result = await this.recovery.flush(id, 'hot-exit');
      if (!result.ok) {
        failedIds.push(id);
        errors.push(result.error.message);
      } else if (this.registry.getDocument(id)?.summary.dirty
        && !this.registry.getDocument(id)?.summary.recoveryProtected) {
        failedIds.push(id);
        errors.push('最新未保存版本尚无已核对的恢复副本。');
      }
    }
    if (failedIds.length > 0) return this.fail(failedIds, errors);
    const savedSession = await this.session.flush();
    if (!savedSession.ok) return this.fail([], [savedSession.error.message]);
    const removed = await this.removeWindowSession();
    if (!removed.ok) return this.fail([], [removed.error.message]);
    try {
      await this.destroy();
      this.publish({ phase: 'idle', error: null, failedDocumentIds: [] });
      return { ok: true, value: { ready: true } };
    } catch {
      return this.fail([], ['窗口关闭请求未确认；本地恢复快照和会话清单已保存。']);
    }
  }

  private async discardAndExitNow(): Promise<ResultEnvelope<{ ready: true }>> {
    this.freeze();
    this.publish({ phase: 'preparing', error: null, failedDocumentIds: [] });
    this.recovery.stop();
    this.session.stop();
    const dirty = this.dirtyIds();
    const failedIds: DocumentId[] = [];
    const errors: string[] = [];
    for (const id of dirty) {
      const document = this.registry.getDocument(id);
      if (!document) continue;
      const throughVersion = document.summary.version;
      if (!Number.isSafeInteger(throughVersion) || throughVersion >= Number.MAX_SAFE_INTEGER) {
        failedIds.push(id);
        errors.push('文档版本无法安全推进，请先另存当前内容。');
        continue;
      }
      let result: ResultEnvelope<DiscardRecoveryResult>;
      try {
        result = await this.discard({ documentId: id, throughVersion });
      } catch {
        result = { ok: false, error: { code: 'IPC_UNAVAILABLE',
          message: '放弃标记的结果未确认，当前正文仍保留。', retryable: false } };
      } finally {
        // The tombstone may already be durable even when its acknowledgement is lost.
        // Advance the generation while retaining the hot-exit input fence and undo.
        this.registry.cancelClose(id, throughVersion);
      }
      if (!result.ok || result.value.documentId !== id
        || result.value.throughVersion !== throughVersion
        || result.value.discarded !== true) {
        failedIds.push(id);
        errors.push(result.ok ? '放弃回执与当前文档版本不匹配。' : result.error.message);
      }
    }
    if (failedIds.length > 0) return this.fail(failedIds, errors);
    const cleared = await this.session.clear();
    if (!cleared.ok) return this.fail([], [cleared.error.message]);
    try {
      await this.destroy();
      this.publish({ phase: 'idle', error: null, failedDocumentIds: [] });
      return { ok: true, value: { ready: true } };
    } catch {
      return this.fail([], ['放弃标记与会话清理已完成，但窗口关闭请求未确认。']);
    }
  }

  private freeze() {
    if (this.frozen) return;
    this.frozen = true;
    this.session.stop();
    this.recovery.stop();
    this.registry.beginHotExit();
  }

  private dirtyIds() {
    return this.registry.getSnapshot().documents
      .filter(document => document.dirty)
      .map(document => document.id);
  }

  private fail(documentIds: readonly DocumentId[], errors: readonly string[]) {
    const unique = [...new Set(errors.filter(Boolean))];
    const message = unique.length > 0
      ? `无法安全退出：${unique.join('；')}`
      : '无法安全退出：恢复状态尚未确认。';
    this.publish({ phase: 'failed', error: message, failedDocumentIds: documentIds });
    return failed(message) as ResultEnvelope<{ ready: true }>;
  }

  private publish(snapshot: HotExitSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
}

export const hotExit = new HotExitCoordinator(documents, recoveries, session);

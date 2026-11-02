import { files } from '../../bridge/files';
import type { DocumentId, ResultEnvelope, WriteRecoverySnapshotRequest, RecoverySnapshotAck } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';
import { saves, type SaveCoordinator } from './save';

const DEBOUNCE_MS = 1_000;
const MAX_WAIT_MS = 5_000;
type TimerHandle = ReturnType<typeof setTimeout>;
type RecoveryTransport = (request: WriteRecoverySnapshotRequest) => Promise<ResultEnvelope<RecoverySnapshotAck>>;
type RecoveryReason = WriteRecoverySnapshotRequest['reason'];

interface Schedule {
  readonly firstAt: number;
  readonly dueAt: number;
  readonly version: number;
  readonly timer: TimerHandle;
}

interface TimerApi {
  now(): number;
  schedule(callback: () => void, delay: number): TimerHandle;
  cancel(timer: TimerHandle): void;
}

const timers: TimerApi = {
  now: () => Date.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: timer => clearTimeout(timer),
};

export class RecoveryCoordinator {
  private readonly schedules = new Map<DocumentId, Schedule>();
  private readonly active = new Map<DocumentId, Promise<ResultEnvelope<RecoverySnapshotAck | null>>>();
  private readonly failedVersions = new Map<DocumentId, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly registry: DocumentRegistry,
    private readonly saving: Pick<SaveCoordinator, 'exclusive'>,
    private readonly transport: RecoveryTransport = files.writeRecoverySnapshot,
    private readonly timer: TimerApi = timers,
  ) {}

  start(): () => void {
    if (this.unsubscribe) return () => this.stop();
    this.unsubscribe = this.registry.subscribe(this.scan);
    this.scan();
    return () => this.stop();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const schedule of this.schedules.values()) this.timer.cancel(schedule.timer);
    this.schedules.clear();
  }

  async flush(id: DocumentId,
    reason: RecoveryReason = 'periodic'): Promise<ResultEnvelope<RecoverySnapshotAck | null>> {
    const pending = this.active.get(id);
    if (pending) {
      const result = await pending;
      if (reason === 'periodic') return result;
    }
    const operation = this.performFlush(id, reason).finally(() => {
      if (this.active.get(id) === operation) this.active.delete(id);
      this.scan();
    });
    this.active.set(id, operation);
    return operation;
  }

  private readonly scan = () => {
    if (!this.unsubscribe) return;
    const ids = new Set(this.registry.getSnapshot().documents.map(document => document.id));
    for (const id of this.schedules.keys()) if (!ids.has(id)) this.cancelSchedule(id);
    for (const id of this.failedVersions.keys()) if (!ids.has(id)) this.failedVersions.delete(id);

    for (const summary of this.registry.getSnapshot().documents) {
      const failedVersion = this.failedVersions.get(summary.id);
      if (failedVersion !== undefined && failedVersion < summary.version) this.failedVersions.delete(summary.id);
      const document = this.registry.getDocument(summary.id);
      if (!summary.dirty || summary.closing || summary.recoveryProtected || !document || document.fragment
        || this.failedVersions.get(summary.id) === summary.version) {
        this.cancelSchedule(summary.id);
        continue;
      }
      if (!this.active.has(summary.id)) this.arm(summary.id, summary.version);
    }
  };

  private arm(id: DocumentId, version: number) {
    const now = this.timer.now();
    const previous = this.schedules.get(id);
    if (previous?.version === version) return;
    if (previous) this.timer.cancel(previous.timer);
    const firstAt = previous?.firstAt ?? now;
    const dueAt = Math.min(now + DEBOUNCE_MS, firstAt + MAX_WAIT_MS);
    const timer = this.timer.schedule(() => this.fire(id, dueAt), Math.max(0, dueAt - now));
    this.schedules.set(id, { firstAt, dueAt, version, timer });
  }

  private fire(id: DocumentId, dueAt: number) {
    const schedule = this.schedules.get(id);
    if (!schedule) return;
    this.schedules.delete(id);
    const remaining = dueAt - this.timer.now();
    if (remaining > 0) {
      const timer = this.timer.schedule(() => this.fire(id, dueAt), remaining);
      this.schedules.set(id, { ...schedule, timer });
      return;
    }
    void this.flush(id, 'periodic');
  }

  private cancelSchedule(id: DocumentId) {
    const schedule = this.schedules.get(id);
    if (!schedule) return;
    this.timer.cancel(schedule.timer);
    this.schedules.delete(id);
  }

  private async performFlush(id: DocumentId,
    reason: RecoveryReason): Promise<ResultEnvelope<RecoverySnapshotAck | null>> {
    this.cancelSchedule(id);
    let attemptedVersion: number | null = null;
    try {
      const result = await this.saving.exclusive<RecoverySnapshotAck | null>(id, async () => {
        const document = this.registry.getDocument(id);
        if (!document || !document.summary.dirty || document.summary.closing || document.fragment) {
          return { ok: true, value: null };
        }
        const captured = this.registry.captureRecovery(id, reason);
        if (!captured.ok) return captured;
        attemptedVersion = captured.value.documentVersion;
        let acknowledged: ResultEnvelope<RecoverySnapshotAck>;
        try {
          acknowledged = await this.transport(captured.value);
        } catch {
          acknowledged = { ok: false, error: {
            code: 'IPC_UNAVAILABLE',
            message: '恢复快照结果未确认，正文仍在内存中。',
            retryable: false,
          } };
        }
        if (!acknowledged.ok) return acknowledged;
        if (acknowledged.value.documentId !== id
          || acknowledged.value.durableVersion !== captured.value.documentVersion) {
          return { ok: false, error: {
            code: 'CONFLICT',
            message: '恢复快照回执与捕获版本不匹配，正文仍在内存中。',
            retryable: false,
          } };
        }
        this.registry.acknowledgeRecovery(
          id,
          captured.value.documentVersion,
          acknowledged.value.receiptId,
        );
        return acknowledged;
      });
      if (!result.ok && attemptedVersion !== null) {
        this.failedVersions.set(id, attemptedVersion);
        this.registry.markRecoveryFailure(id, attemptedVersion, result.error.message);
      }
      return result;
    } catch {
      if (attemptedVersion !== null) {
        this.failedVersions.set(id, attemptedVersion);
        this.registry.markRecoveryFailure(id, attemptedVersion, '恢复快照结果未确认，正文仍在内存中。');
      }
      return { ok: false, error: {
        code: 'IPC_UNAVAILABLE',
        message: '恢复快照结果未确认，正文仍在内存中。',
        retryable: false,
      } };
    }
  }
}

export const recoveries = new RecoveryCoordinator(documents, saves);

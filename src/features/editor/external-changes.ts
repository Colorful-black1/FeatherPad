import { externalFiles } from '../../bridge/external';
import { files } from '../../bridge/files';
import type { DiskRevision, DocumentId, FileMetadata, OpenDocument, ResultEnvelope } from '../../shared/contracts/files';
import type { FilesystemChanged } from '../../shared/contracts/external';
import { documents, type DocumentRegistry } from './documents';
import { saves, type SaveCoordinator } from './save';
import { recoveries, type RecoveryCoordinator } from './recovery';

export interface ExternalStatus {
  kind: 'changed' | 'missing' | 'unavailable' | 'reloaded';
  message: string;
  revision?: DiskRevision;
}

type ExternalTransport = Omit<typeof externalFiles, 'overwrite'> & { stat: (id: DocumentId) => Promise<ResultEnvelope<FileMetadata>> };
const conflict = (message: string): ResultEnvelope<never> => ({ ok: false, error: { code: 'CONFLICT', message, retryable: false } });

export class ExternalChanges {
  private statuses: ReadonlyMap<DocumentId, ExternalStatus> = new Map();
  private readonly listeners = new Set<() => void>();
  private readonly checking = new Map<DocumentId, Promise<void>>();
  private readonly recheck = new Set<DocumentId>();
  private unsubscribe: (() => void) | null = null;
  private unlisten: (() => void) | null = null;
  private watchId: string | null = null;
  private watchKey = '';
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private restartWatch = false;
  private listenError: string | null = null;
  private watchError: string | null = null;
  private refreshChain = Promise.resolve();

  constructor(private readonly registry: DocumentRegistry,
    private readonly saving: Pick<SaveCoordinator, 'exclusive'>,
    private readonly recovery: Pick<RecoveryCoordinator, 'flush'>,
    private readonly transport: ExternalTransport = { ...externalFiles, stat: files.stat }) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.statuses;

  start(): () => void {
    if (this.unsubscribe) return () => this.stop();
    const generation = ++this.generation;
    this.listenError = null; this.watchError = null;
    this.unsubscribe = this.registry.subscribe(this.syncWatches);
    void this.transport.listen(this.receive).then(unlisten => {
      if (this.generation === generation && this.unsubscribe) this.unlisten = unlisten;
      else unlisten();
    }).catch(() => {
      if (this.generation !== generation || !this.unsubscribe) return;
      this.listenError = '文件监听不可用；重新聚焦窗口或点击重新核对可检查磁盘。';
      for (const summary of this.registry.getSnapshot().documents) this.set(summary.id,
        { kind: 'unavailable', message: this.listenError });
    });
    window.addEventListener('focus', this.onFocus);
    this.syncWatches();
    this.onFocus();
    return () => this.stop();
  }

  stop() {
    ++this.generation;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unlisten?.(); this.unlisten = null;
    window.removeEventListener('focus', this.onFocus);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.restartWatch = false;
    this.watchKey = '';
    this.recheck.clear();
    const id = this.watchId; this.watchId = null;
    if (id) void this.transport.stop(id);
  }

  readonly receive = (event: FilesystemChanged) => {
    if (event.watchId !== this.watchId || !this.unsubscribe) return;
    // Every event, including overflow/sequence gaps, invalidates all open refs.
    // A delayed/coalesced notification is never treated as proof of a safe disk.
    if (this.timer) clearTimeout(this.timer);
    this.restartWatch ||= event.overflow;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.restartWatch) { this.restartWatch = false; this.watchKey = ''; this.syncWatches(); }
      this.onFocus();
    }, 100);
  };

  readonly onFocus = () => { void this.checkAll(); };

  async checkAll() {
    await Promise.all(this.registry.getSnapshot().documents.map(summary => this.check(summary.id)));
  }

  check(id: DocumentId): Promise<void> {
    const active = this.checking.get(id);
    if (active) { this.recheck.add(id); return active; }
    const generation = this.generation;
    const run = this.saving.exclusive(id, async () => {
      const document = this.registry.getDocument(id);
      if (!document?.source || document.summary.closing || document.summary.hotExitFrozen || document.releaseUncertain) {
        return { ok: true as const, value: null };
      }
      const base = document.source.metadata.diskRevision;
      const version = document.summary.version;
      const ref = document.source.ref;
      const disk = await this.transport.stat(id);
      const latest = this.registry.getDocument(id);
      if (this.generation !== generation || !latest?.source || latest.source.metadata.diskRevision !== base
        || latest.source.ref.grantId !== ref.grantId || latest.source.ref.relativePath !== ref.relativePath) {
        return { ok: true as const, value: null };
      }
      if (!disk.ok) {
        if (disk.error.code === 'NOT_FOUND') this.registry.markExternalMissing(id);
        this.set(id, { kind: disk.error.code === 'NOT_FOUND' ? 'missing' : 'unavailable', message: disk.error.message });
      } else if (disk.value.diskRevision === base && !latest.summary.missing) {
        const monitoringError = this.listenError ?? this.watchError;
        if (monitoringError) this.set(id, { kind: 'unavailable', message: monitoringError });
        else if (this.statuses.get(id)?.kind !== 'reloaded') this.clear(id);
      } else if (latest.summary.dirty || latest.summary.version !== version || latest.summary.closing || latest.summary.hotExitFrozen) {
        this.set(id, { kind: 'changed', revision: disk.value.diskRevision, message: '磁盘文件已变化；当前未保存内容仍保留。' });
      } else {
        const loaded = await this.transport.reload(id, disk.value.diskRevision);
        if (this.generation !== generation) return { ok: true as const, value: null };
        const applied = loaded.ok ? this.registry.applyDiskReload(loaded.value, version, base) : loaded;
        this.set(id, applied.ok
          ? { kind: 'reloaded', message: '已自动重新载入磁盘上的外部修改。' }
          : { kind: 'changed', revision: disk.value.diskRevision, message: applied.error.message });
      }
      return { ok: true as const, value: null };
    }).then(() => {}).finally(() => {
      this.checking.delete(id);
      if (this.recheck.delete(id) && (this.generation === generation || this.unsubscribe)) void this.check(id);
    });
    this.checking.set(id, run);
    return run;
  }

  async compare(id: DocumentId): Promise<ResultEnvelope<OpenDocument>> {
    return this.saving.exclusive(id, async () => {
      const snapshot = await this.transport.snapshot(id);
      if (snapshot.ok) this.set(id, { kind: 'changed', revision: snapshot.value.metadata.diskRevision,
        message: '已读取磁盘快照；覆盖与重新载入会再次核对这个版本。' });
      return snapshot;
    });
  }

  async reload(id: DocumentId, revision: DiskRevision, expectedVersion = this.registry.getDocument(id)?.summary.version): Promise<ResultEnvelope<{ reloaded: true }>> {
    if (this.registry.getDocument(id)?.summary.version !== expectedVersion) return conflict('缓冲已变化，请重新确认重载。');
    const protectedDraft = await this.recovery.flush(id, 'hot-exit');
    if (!protectedDraft.ok) return protectedDraft;
    return this.saving.exclusive(id, async () => {
      const document = this.registry.getDocument(id);
      if (!document?.source) return conflict('原文件当前未绑定，请另存当前正文。');
      if (document.summary.version !== expectedVersion) return conflict('确认后又有新输入，已保留正文，请重新确认重载。');
      if (document.summary.dirty && !document.summary.recoveryProtected) return conflict('最新输入尚未确认落盘保护，请重试或另存。');
      const version = document.summary.version;
      const base = document.source.metadata.diskRevision;
      const loaded = await this.transport.reload(id, revision);
      if (!loaded.ok) return loaded;
      const applied = this.registry.applyDiskReload(loaded.value, version, base, true);
      if (applied.ok) this.set(id, { kind: 'reloaded', message: '已重新载入磁盘；重载前的未保存正文仍保留在恢复记录。' });
      return applied;
    });
  }

  clear(id: DocumentId) {
    if (!this.statuses.has(id)) return;
    const next = new Map(this.statuses); next.delete(id); this.statuses = next;
    this.listeners.forEach(listener => listener());
  }

  private set(id: DocumentId, status: ExternalStatus) {
    if (!this.registry.getDocument(id)) return;
    const previous = this.statuses.get(id);
    if (previous?.kind === status.kind && previous.message === status.message && previous.revision === status.revision) return;
    this.statuses = new Map(this.statuses).set(id, status);
    this.listeners.forEach(listener => listener());
  }

  private readonly syncWatches = () => {
    const refs = this.registry.getSnapshot().documents.flatMap(summary => {
      const doc = this.registry.getDocument(summary.id);
      return doc?.source && !summary.missing ? [doc.source.ref] : [];
    });
    const key = JSON.stringify(refs);
    if (key === this.watchKey) return;
    this.watchKey = key;
    const generation = this.generation;
    this.refreshChain = this.refreshChain.then(async () => {
      if (generation !== this.generation || key !== this.watchKey) return;
      const old = this.watchId; this.watchId = null;
      if (old) await this.transport.stop(old);
      if (refs.length === 0) return;
      const started = await this.transport.start(refs);
      if (generation !== this.generation || key !== this.watchKey) {
        if (started.ok) await this.transport.stop(started.value.watchId);
        return;
      }
      if (started.ok) { this.watchError = null; this.watchId = started.value.watchId; await this.checkAll(); }
      else if (started.error.code === 'OUT_OF_SCOPE') {
        // A stale reference cannot be watched, but the document buffer and
        // stat-based checks remain valid. Do not paint every open file as failed.
        this.watchError = null;
        this.watchKey = '';
        await this.checkAll();
      } else {
        this.watchError = `监听未建立：${started.error.message}`;
        for (const summary of this.registry.getSnapshot().documents) this.set(summary.id,
          { kind: 'unavailable', message: this.watchError });
        this.watchKey = '';
      }
    });
    for (const id of this.statuses.keys()) if (!this.registry.getDocument(id)) this.clear(id);
  };
}

export const externalChanges = new ExternalChanges(documents, saves, recoveries);

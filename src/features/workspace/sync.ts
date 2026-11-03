import { externalFiles } from '../../bridge/external';
import type { FilesystemChanged } from '../../shared/contracts/external';
import type { FileRef } from '../../shared/contracts/files';
import type { WorkspaceStore } from './store';

type SyncTransport = Pick<typeof externalFiles, 'start' | 'stop' | 'listen'>;

export class WorkspaceSync {
  private unsubscribeStore: (() => void) | null = null;
  private unlisten: (() => void) | null = null;
  private watchId: string | null = null;
  private key = '';
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private overflow = false;
  private lastSequence = 0;
  private syncKey = Promise.resolve();

  constructor(private readonly store: WorkspaceStore,
    private readonly transport: SyncTransport = externalFiles) {}

  start(): () => void {
    if (this.unsubscribeStore) return () => this.stop();
    const generation = ++this.generation;
    this.unsubscribeStore = this.store.subscribe(this.sync);
    void this.transport.listen(this.receive).then(unlisten => {
      if (this.generation === generation && this.unsubscribeStore) this.unlisten = unlisten;
      else unlisten();
    }).catch(() => this.store.setSyncStatus({
      kind: 'unavailable', message: '目录监听不可用；刷新或重新聚焦窗口仍会核对磁盘。',
    }));
    window.addEventListener('focus', this.onFocus);
    this.sync();
    return () => this.stop();
  }

  stop() {
    ++this.generation;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener('focus', this.onFocus);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.key = '';
    const id = this.watchId;
    this.watchId = null;
    if (id) void this.transport.stop(id);
  }

  readonly receive = (event: FilesystemChanged) => {
    if (event.watchId !== this.watchId || !this.unsubscribeStore) return;
    this.overflow ||= event.overflow || (this.lastSequence > 0 && event.sequence > this.lastSequence + 1);
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    this.store.setSyncStatus({ kind: 'syncing', message: '检测到磁盘变化，正在同步目录…' });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.overflow) {
        this.overflow = false;
        this.key = '';
        this.sync();
      } else this.store.refresh();
    }, 100);
  };

  readonly onFocus = () => {
    if (this.store.getSnapshot().root) this.store.refresh();
  };

  private readonly sync = () => {
    const snapshot = this.store.getSnapshot();
    const refs: FileRef[] = snapshot.root ? [snapshot.root.grant, ...Object.keys(snapshot.records)
      .filter(path => path !== '' && snapshot.expanded[path])
      .slice(0, 63)
      .map(relativePath => ({ grantId: snapshot.root!.grant.grantId, relativePath }))] : [];
    const key = JSON.stringify(refs);
    if (key === this.key) return;
    this.key = key;
    const generation = this.generation;
    this.syncKey = this.syncKey.then(async () => {
      if (generation !== this.generation || key !== this.key) return;
      const previous = this.watchId;
      this.watchId = null;
      this.lastSequence = 0;
      if (previous) await this.transport.stop(previous);
      if (refs.length === 0) {
        this.store.setSyncStatus({ kind: 'ready', message: null });
        return;
      }
      const started = await this.transport.start(refs);
      if (generation !== this.generation || key !== this.key) {
        if (started.ok) await this.transport.stop(started.value.watchId);
        return;
      }
      if (!started.ok) {
        this.store.setSyncStatus({ kind: 'unavailable', message: `目录监听未建立：${started.error.message}` });
        return;
      }
      this.watchId = started.value.watchId;
      this.store.setSyncStatus({ kind: 'ready', message: null });
    }).catch(() => this.store.setSyncStatus({
      kind: 'unavailable', message: '目录监听更新失败；可手动刷新。',
    }));
  };
}

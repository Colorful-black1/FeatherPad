import { files } from '../../bridge/files';
import type { DocumentId, GrantId, OpenDocument, ResultEnvelope, SessionClearResult, SessionLoadResult, SessionManifest, SessionSaveResult, SessionView, SessionWindow } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from '../editor/documents';
import { tabs, type TabController } from '../editor/tabs';
import { workspace, type WorkspaceStore } from '../workspace/store';

const SESSION_DEBOUNCE_MS = 1_000;
const SESSION_MAX_WAIT_MS = 5_000;
type TimerHandle = ReturnType<typeof setTimeout>;
type SaveSession = (manifest: SessionManifest) => Promise<ResultEnvelope<SessionSaveResult>>;
type LoadSession = () => Promise<ResultEnvelope<SessionLoadResult>>;
type ClearSession = () => Promise<ResultEnvelope<SessionClearResult>>;
type OpenSessionFile = typeof files.open;

export interface MissingSessionSource {
  id: string;
  title: string;
  kind: 'file' | 'workspace';
}

interface SessionSnapshot {
  phase: 'idle' | 'saving' | 'failed';
  persistedAt: string | null;
  error: string | null;
  missingSources: readonly MissingSessionSource[];
}

interface Schedule {
  firstAt: number;
  dueAt: number;
  timer: TimerHandle;
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

function fingerprint(manifest: SessionManifest) {
  return JSON.stringify({ ...manifest, persistedAt: '' });
}

function currentBounds(): SessionWindow['bounds'] {
  if (typeof window === 'undefined') return { x: 0, y: 0, width: 1200, height: 800 };
  return {
    x: Number.isFinite(window.screenX) ? Math.trunc(window.screenX) : 0,
    y: Number.isFinite(window.screenY) ? Math.trunc(window.screenY) : 0,
    // setSize restores the content area; using outer dimensions adds a frame on every restart.
    width: Math.max(1, Math.trunc(window.innerWidth || 1200)),
    height: Math.max(1, Math.trunc(window.innerHeight || 800)),
  };
}

export class SessionCoordinator {
  private sessionId: string | null = null;
  private schedule: Schedule | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { phase: 'idle', persistedAt: null, error: null, missingSources: [] };
  private pendingViews: SessionView[] = [];
  private pendingRoot: { id: string; label: string } | null = null;
  private activeSave: Promise<ResultEnvelope<SessionSaveResult>> | null = null;
  private lastSavedFingerprint: string | null = null;
  private lastSaveResult: ResultEnvelope<SessionSaveResult> | null = null;

  constructor(
    private readonly registry: DocumentRegistry,
    private readonly tabController: Pick<TabController, 'subscribe' | 'getSnapshot' | 'restorePreview'>,
    private readonly workspaceStore: Pick<WorkspaceStore, 'subscribe' | 'getSnapshot' | 'setRoot'>,
    private readonly saveTransport: SaveSession = files.saveSession,
    private readonly loadTransport: LoadSession = files.loadSession,
    private readonly clearTransport: ClearSession = files.clearSession,
    private readonly openTransport: OpenSessionFile = files.open,
    private readonly timer: TimerApi = timers,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  start(): () => void {
    if (this.unsubscribers.length > 0) return () => this.stop();
    this.unsubscribers.push(
      this.registry.subscribeSession(this.changed),
      this.tabController.subscribe(this.changed),
      this.workspaceStore.subscribe(this.changed),
    );
    return () => this.stop();
  }

  stop() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.cancelSchedule();
  }

  async load(): Promise<ResultEnvelope<SessionLoadResult>> {
    const result = await this.loadTransport();
    if (result.ok && result.value.session) this.sessionId = result.value.session.sessionId;
    return result;
  }

  async restoreSources(
    manifest: SessionManifest,
    availableGrantIds: readonly string[],
  ): Promise<{ sources: Map<DocumentId, OpenDocument>; warnings: string[] }> {
    const window = manifest.windows.find(candidate => candidate.windowId === 'main') ?? manifest.windows[0];
    const sources = new Map<DocumentId, OpenDocument>();
    const warnings: string[] = [];
    if (!window) return { sources, warnings };
    const available = new Set(availableGrantIds);
    const rootId = window.rootIds[0];
    const rootLabel = window.rootLabels[0];
    if (rootId && rootLabel) {
      if (available.has(rootId)) {
        this.pendingRoot = null;
        this.workspaceStore.setRoot({
          grant: { grantId: rootId as GrantId, relativePath: '' },
          displayName: rootLabel,
        });
      } else {
        this.pendingRoot = { id: rootId, label: rootLabel };
        warnings.push(`工作区“${rootLabel}”的目录授权已失效，请重新选择。`);
      }
    }
    for (const view of window.views) {
      if (!view.fileRef) continue;
      if (!available.has(view.fileRef.grantId)) {
        warnings.push(`“${view.title}”的文件授权已失效，无法自动打开。`);
        continue;
      }
      if (sources.has(view.documentId)) continue;
      const opened = await this.openTransport(
        view.fileRef,
        view.openMode === 'head-preview' ? 'head-preview' : undefined,
        view.documentId,
      );
      if (!opened.ok) {
        warnings.push(`“${view.title}”无法自动打开：${opened.error.message}`);
        continue;
      }
      const id = this.registry.openDocument(opened.value);
      if (id !== view.documentId) {
        warnings.push(`“${view.title}”的文件身份与会话记录不一致，已保留为缺失标签。`);
        continue;
      }
      sources.set(id, opened.value);
    }
    return { sources, warnings };
  }

  apply(manifest: SessionManifest): { applied: number; missing: number; warnings: string[] } {
    const window = manifest.windows.find(candidate => candidate.windowId === 'main') ?? manifest.windows[0];
    if (!window) {
      this.sessionId = manifest.sessionId;
      this.lastSavedFingerprint = fingerprint(this.capture(manifest.sessionId));
      return { applied: 0, missing: 0, warnings: [] };
    }
    this.sessionId = manifest.sessionId;
    const warnings: string[] = [];
    const existing = window.views.filter(view => {
      const document = this.registry.getDocument(view.documentId);
      if (!document) return false;
      if (view.dirty && (!view.recoveryReceiptId
        || document.recoveryReceiptId !== view.recoveryReceiptId)) {
        warnings.push(`“${view.title}”的恢复副本未通过会话交叉校验，已保留可读取的恢复正文。`);
        return false;
      }
      return true;
    });
    this.registry.reorder(existing.map(view => view.documentId));
    for (const view of existing) {
      this.registry.restoreSessionState(view.documentId,
        view.selection, view.scrollAnchor, 0, view.bufferVersion);
    }
    const active = existing.find(view => view.viewId === window.activeViewId);
    if (active) this.registry.activate(active.documentId);
    const preview = existing.find(view => view.isPreview);
    this.tabController.restorePreview(preview?.documentId ?? null);
    this.pendingViews = window.views.filter(view => !this.registry.getDocument(view.documentId));
    this.lastSavedFingerprint = fingerprint(this.capture(manifest.sessionId));
    this.publish(this.snapshot);
    const missing = window.views.length - existing.length;
    if (missing > 0) warnings.push(`${missing} 个标签的正文或恢复引用未能安全恢复。`);
    return {
      applied: existing.length,
      missing,
      warnings,
    };
  }

  async flush(): Promise<ResultEnvelope<SessionSaveResult>> {
    this.cancelSchedule();
    if (this.activeSave) await this.activeSave;
    return this.saveNow(true);
  }

  async clear(): Promise<ResultEnvelope<SessionClearResult>> {
    const result = await this.clearTransport();
    if (result.ok) {
      this.lastSavedFingerprint = null;
      this.lastSaveResult = null;
      this.publish({ phase: 'idle', persistedAt: null, error: null });
    }
    return result;
  }

  forgetMissing(id: string) {
    this.pendingViews = this.pendingViews.filter(view => view.viewId !== id);
    if (this.pendingRoot?.id === id) this.pendingRoot = null;
    this.publish(this.snapshot);
    this.changed();
  }

  private readonly changed = () => {
    if (this.workspaceStore.getSnapshot().root) this.pendingRoot = null;
    this.arm();
  };

  private arm() {
    const now = this.timer.now();
    if (this.schedule) this.timer.cancel(this.schedule.timer);
    const firstAt = this.schedule?.firstAt ?? now;
    const dueAt = Math.min(now + SESSION_DEBOUNCE_MS, firstAt + SESSION_MAX_WAIT_MS);
    const timer = this.timer.schedule(() => {
      this.schedule = null;
      void this.saveNow(false);
    }, Math.max(0, dueAt - now));
    this.schedule = { firstAt, dueAt, timer };
  }

  private cancelSchedule() {
    if (!this.schedule) return;
    this.timer.cancel(this.schedule.timer);
    this.schedule = null;
  }

  private capture(sessionId = this.sessionId ?? crypto.randomUUID()): SessionManifest {
    this.sessionId = sessionId;
    const state = this.registry.getSnapshot();
    const tabState = this.tabController.getSnapshot();
    const workspaceState = this.workspaceStore.getSnapshot();
    const views: SessionView[] = state.documents.map(document => {
      const record = this.registry.getDocument(document.id);
      const selection = record?.state.selection.ranges.map(range => ({
        anchor: range.anchor,
        head: range.head,
      })) ?? [{ anchor: 0, head: 0 }];
      return {
        viewId: document.id,
        bufferVersion: document.version,
        documentId: document.id,
        recoveryReceiptId: document.dirty && document.recoveryProtected
          ? record?.recoveryReceiptId ?? null
          : null,
        fileRef: record?.source?.ref ?? null,
        diskRevision: record?.source?.metadata.diskRevision ?? null,
        openMode: record?.fragment && (record.source?.metadata.sizeBytes ?? 0) > 100 * 1024 * 1024
          ? 'head-preview'
          : 'normal',
        title: document.title,
        displayPath: document.displayPath,
        isPreview: tabState.previewId === document.id,
        dirty: document.dirty,
        selection,
        scrollAnchor: Math.max(0, record?.scroll.top ?? 0),
      };
    });
    this.pendingViews = this.pendingViews.filter(view => !views.some(current =>
      current.documentId === view.documentId || (view.displayPath !== null
        && current.displayPath?.toLocaleLowerCase() === view.displayPath.toLocaleLowerCase())));
    views.push(...this.pendingViews);
    if (workspaceState.root) this.pendingRoot = null;
    const refs = [...new Set(views
      .map(view => view.recoveryReceiptId)
      .filter((receipt): receipt is string => receipt !== null))];
    const windowSession: SessionWindow = {
      windowId: 'main',
      bounds: currentBounds(),
      rootIds: workspaceState.root ? [workspaceState.root.grant.grantId]
        : this.pendingRoot ? [this.pendingRoot.id] : [],
      rootLabels: workspaceState.root ? [workspaceState.root.displayName]
        : this.pendingRoot ? [this.pendingRoot.label] : [],
      activeViewId: state.activeId,
      groups: [{ groupId: 'primary', viewIds: views.map(view => view.viewId) }],
      views,
    };
    return {
      schemaVersion: 1,
      sessionId,
      windows: [windowSession],
      recoverySnapshotRefs: refs,
      persistedAt: new Date(this.timer.now()).toISOString(),
    };
  }

  private async saveNow(force: boolean): Promise<ResultEnvelope<SessionSaveResult>> {
    if (this.activeSave) return this.activeSave;
    const manifest = this.capture();
    const currentFingerprint = fingerprint(manifest);
    if (!force && currentFingerprint === this.lastSavedFingerprint && this.lastSaveResult) {
      return this.lastSaveResult;
    }
    this.publish({ ...this.snapshot, phase: 'saving', error: null });
    const operation = this.saveTransport(manifest).then(result => {
      this.lastSaveResult = result;
      if (result.ok) {
        this.lastSavedFingerprint = currentFingerprint;
        this.publish({ phase: 'idle', persistedAt: result.value.persistedAt, error: null });
      } else {
        this.publish({ phase: 'failed', persistedAt: this.snapshot.persistedAt,
          error: `会话状态未保存：${result.error.message}` });
      }
      return result;
    }).catch((): ResultEnvelope<SessionSaveResult> => {
      const result = { ok: false as const, error: {
        code: 'IPC_UNAVAILABLE' as const,
        message: '会话状态结果未确认，正文恢复仍以本地快照为准。',
        retryable: false,
      } };
      this.lastSaveResult = result;
      this.publish({ phase: 'failed', persistedAt: this.snapshot.persistedAt, error: result.error.message });
      return result;
    }).finally(() => {
      if (this.activeSave === operation) this.activeSave = null;
    });
    this.activeSave = operation;
    return operation;
  }

  private publish(snapshot: Omit<SessionSnapshot, 'missingSources'>) {
    this.snapshot = { ...snapshot, missingSources: [
      ...(this.pendingRoot ? [{ id: this.pendingRoot.id, title: this.pendingRoot.label, kind: 'workspace' as const }] : []),
      ...this.pendingViews.map(view => ({ id: view.viewId, title: view.title, kind: 'file' as const })),
    ] };
    this.listeners.forEach(listener => listener());
  }
}

export const session = new SessionCoordinator(documents, tabs, workspace);

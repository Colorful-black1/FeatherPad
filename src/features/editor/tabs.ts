import { files } from '../../bridge/files';
import type { EncodingId } from '../../shared/contracts/encoding';
import type { DocumentId, FileRef, OpenMode, ResultEnvelope } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';
import { closes, type CloseChoice, type CloseCoordinator, type CloseResult } from './close';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface RecentlyClosedTab {
  title: string;
  displayPath: string | null;
  ref: FileRef | null;
}
export type TabCloseScope = 'current' | 'others' | 'right' | 'clean';
interface TabSnapshot {
  previewId: DocumentId | null;
  warning: string | null;
  primaryId: DocumentId | null;
  secondaryId: DocumentId | null;
  focusedGroup: 'primary' | 'secondary';
  recentlyClosed: readonly RecentlyClosedTab[];
}
interface OpenTabResult { id: DocumentId; warning: string | null }
const preferenceKey = 'featherpad.tabs.pins.v1';
const isPinnedPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32_767;

function browserStorage(): PreferenceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export class TabController {
  private snapshot: TabSnapshot = {
    previewId: null, warning: null, primaryId: null, secondaryId: null,
    focusedGroup: 'primary', recentlyClosed: [],
  };
  private previewVersion = 0;
  private readonly pinnedPaths = new Set<string>();
  private readonly knownPaths = new Map<DocumentId, string | null>();
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly registry: DocumentRegistry, private readonly closing: CloseCoordinator,
    private readonly openFile: typeof files.open = files.open, private readonly storage: PreferenceStorage | null = browserStorage()) {
    try {
      const raw = storage?.getItem(preferenceKey);
      if (raw) {
        if (raw.length > 4 * 1024 * 1024 || new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) throw new Error('Large preferences');
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Reflect.get(value, 'schemaVersion') !== 1) throw new Error('Invalid preferences');
        const paths: unknown = Reflect.get(value, 'pinnedPaths');
        if (!Array.isArray(paths) || paths.length > 10_000 || !paths.every(isPinnedPath)) throw new Error('Invalid paths');
        paths.forEach(path => { this.pinnedPaths.add(path); });
      }
    } catch { this.snapshot = { ...this.snapshot, warning: '固定标签状态无法读取，当前文档仍可正常使用。' }; }
    if (!storage && typeof window !== 'undefined') this.snapshot = { ...this.snapshot, warning: '固定标签状态无法保存，当前标签仍保留。' };
    registry.subscribe(() => {
      const id = this.snapshot.previewId;
      const document = id ? registry.getDocument(id) : undefined;
      if (id && (!document || document.summary.dirty || document.releaseUncertain || document.summary.version !== this.previewVersion)) this.pin(id);
      let changed = false;
      const live = new Set<DocumentId>();
      const summaries = registry.getSnapshot().documents;
      for (const summary of summaries) {
        live.add(summary.id);
        const previous = this.knownPaths.get(summary.id);
        if (previous !== undefined && previous !== summary.displayPath) {
          if (previous && !summaries.some(other => other.id !== summary.id && other.displayPath === previous && other.id !== this.snapshot.previewId)) {
            changed = this.pinnedPaths.delete(previous) || changed;
          }
          if (summary.displayPath && summary.id !== this.snapshot.previewId) {
            this.pinnedPaths.add(summary.displayPath);
            changed = true;
          }
        }
        this.knownPaths.set(summary.id, summary.displayPath);
      }
      const activeId = registry.getSnapshot().activeId;
      const secondaryId = this.snapshot.secondaryId && live.has(this.snapshot.secondaryId)
        ? this.snapshot.secondaryId : null;
      const primaryId = secondaryId
        ? this.snapshot.primaryId && live.has(this.snapshot.primaryId)
          ? this.snapshot.primaryId
          : activeId && live.has(activeId) && activeId !== secondaryId
            ? activeId
            : summaries.find(summary => summary.id !== secondaryId)?.id ?? secondaryId ?? null
        : activeId && live.has(activeId)
          ? activeId
          : summaries[0]?.id ?? null;
      const focusedGroup = secondaryId ? this.snapshot.focusedGroup : 'primary';
      if (primaryId !== this.snapshot.primaryId || secondaryId !== this.snapshot.secondaryId
        || focusedGroup !== this.snapshot.focusedGroup) {
        this.snapshot = { ...this.snapshot, primaryId, secondaryId, focusedGroup };
        this.listeners.forEach(listener => listener());
      }
      for (const knownId of this.knownPaths.keys()) if (!live.has(knownId)) this.knownPaths.delete(knownId);
      if (changed) this.persist();
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  createUntitled(): Promise<DocumentId> {
    return this.enqueue(async () => {
      const id = this.registry.createUntitled();
      this.focusFocusedGroup(id);
      return id;
    });
  }

  pin(id: DocumentId) {
    const document = this.registry.getDocument(id);
    if (this.snapshot.previewId === id) this.publish(null, this.snapshot.warning);
    if (document?.summary.displayPath) {
      this.pinnedPaths.add(document.summary.displayPath);
      this.persist();
    }
  }

  restorePreview(id: DocumentId | null) {
    if (id === null) {
      this.publish(null, this.snapshot.warning);
      return;
    }
    const document = this.registry.getDocument(id);
    if (!document) return;
    this.previewVersion = document.summary.version;
    this.publish(document.summary.dirty ? null : id, this.snapshot.warning);
  }

  split(id: DocumentId) {
    if (!this.registry.getDocument(id)) return false;
    const primaryId = this.snapshot.primaryId ?? this.registry.getSnapshot().activeId ?? id;
    this.snapshot = { ...this.snapshot, primaryId, secondaryId: id, focusedGroup: 'secondary' };
    this.registry.activate(id);
    this.listeners.forEach(listener => listener());
    return true;
  }

  focusPrimary(id: DocumentId) {
    if (!this.registry.getDocument(id)) return false;
    this.snapshot = { ...this.snapshot, primaryId: id, focusedGroup: 'primary' };
    this.registry.activate(id);
    this.listeners.forEach(listener => listener());
    return true;
  }

  focusSecondary(id: DocumentId) {
    if (!this.registry.getDocument(id)) return false;
    this.snapshot = { ...this.snapshot, secondaryId: id, focusedGroup: 'secondary' };
    this.registry.activate(id);
    this.listeners.forEach(listener => listener());
    return true;
  }

  closeSplit() {
    this.snapshot = { ...this.snapshot, secondaryId: null, focusedGroup: 'primary' };
    const primaryId = this.snapshot.primaryId;
    if (primaryId) this.registry.activate(primaryId);
    this.listeners.forEach(listener => listener());
  }

  closeCandidates(scope: TabCloseScope, anchorId = this.registry.getSnapshot().activeId): readonly DocumentId[] {
    const ids = this.registry.getSnapshot().documents.map(document => document.id);
    if (!anchorId || !ids.includes(anchorId)) return [];
    if (scope === 'current') return [anchorId];
    if (scope === 'others') return ids.filter(id => id !== anchorId);
    if (scope === 'right') return ids.slice(ids.indexOf(anchorId) + 1);
    return this.registry.getSnapshot().documents
      .filter(document => !document.dirty && !document.closing)
      .map(document => document.id);
  }

  async reopenLastClosed(): Promise<ResultEnvelope<OpenTabResult> | null> {
    const previous = this.snapshot.recentlyClosed.at(-1);
    if (!previous) return null;
    this.snapshot = { ...this.snapshot, recentlyClosed: this.snapshot.recentlyClosed.slice(0, -1) };
    this.listeners.forEach(listener => listener());
    if (!previous.ref) return {
      ok: false,
      error: { code: 'UNSUPPORTED', message: '未命名文档关闭后不能从最近关闭恢复。', retryable: false },
    };
    const result = await this.open(previous.ref, 'pinned');
    if (!result.ok) {
      this.snapshot = { ...this.snapshot, recentlyClosed: [...this.snapshot.recentlyClosed, previous] };
      this.listeners.forEach(listener => listener());
    }
    return result;
  }

  open(reference: FileRef, intent: 'preview' | 'pinned' = 'pinned', mode?: Exclude<OpenMode, 'normal'>,
    encoding?: EncodingId): Promise<ResultEnvelope<OpenTabResult>> {
    return this.enqueue(async () => {
      const result = encoding ? await this.openFile(reference, mode, undefined, encoding) : await this.openFile(reference, mode);
      if (!result.ok) return result;
      const existing = this.registry.getDocument(result.value.documentId);
      const previousId = this.snapshot.previewId;
      const previousVersion = previousId ? this.registry.getDocument(previousId)?.summary.version : undefined;
      const id = this.registry.openDocument(result.value);
      if (existing) {
        if (intent === 'pinned') this.pin(id);
        if (this.snapshot.focusedGroup === 'secondary') this.focusSecondary(id);
        else this.focusPrimary(id);
        return { ok: true, value: { id, warning: this.snapshot.warning } };
      }
      if (intent === 'pinned' || this.pinnedPaths.has(result.value.metadata.displayPath)) {
        this.pin(id);
        if (this.snapshot.focusedGroup === 'secondary') this.focusSecondary(id);
        else this.focusPrimary(id);
      }
      else {
        if (previousId) this.pin(previousId);
        this.previewVersion = this.registry.getDocument(id)!.summary.version;
        this.publish(id, this.snapshot.warning);
        this.focusFocusedGroup(id);
        if (previousId && previousVersion !== undefined && !this.registry.getDocument(previousId)?.summary.dirty) {
          const closed = await this.closeNow(previousId, previousVersion, 'clean');
          if (!closed.ok) return { ok: true, value: { id, warning: `原预览仍保留：${closed.error.message}` } };
        }
      }
      return { ok: true, value: { id, warning: this.snapshot.warning } };
    });
  }

  close(id: DocumentId, version: number, choice: CloseChoice): Promise<ResultEnvelope<CloseResult>> {
    return this.enqueue(() => this.closeNow(id, version, choice));
  }

  private async closeNow(id: DocumentId, version: number, choice: CloseChoice): Promise<ResultEnvelope<CloseResult>> {
    const summary = this.registry.getDocument(id)?.summary;
    const path = summary?.displayPath;
    const reference = this.registry.getDocument(id)?.source?.ref ?? null;
    const result = await this.closing.close(id, version, choice);
    if (result.ok && result.value.closed) {
      if (summary) {
        this.snapshot = {
          ...this.snapshot,
          recentlyClosed: [...this.snapshot.recentlyClosed,
            { title: summary.title, displayPath: summary.displayPath, ref: reference }].slice(-10),
        };
      }
      if (path && !this.registry.getSnapshot().documents.some(document =>
        document.displayPath === path && document.id !== this.snapshot.previewId)) this.pinnedPaths.delete(path);
      this.persist();
    }
    return result;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const scheduled = this.pending.then(run, run);
    this.pending = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private focusFocusedGroup(id: DocumentId) {
    if (this.snapshot.secondaryId && this.snapshot.focusedGroup === 'secondary') this.focusSecondary(id);
    else this.focusPrimary(id);
  }

  private persist() {
    try {
      const raw = JSON.stringify({ schemaVersion: 1, pinnedPaths: [...this.pinnedPaths] });
      if (!this.storage || this.pinnedPaths.size > 10_000 || new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) throw new Error('Unavailable preferences');
      this.storage.setItem(preferenceKey, raw);
      if (this.snapshot.warning) this.publish(this.snapshot.previewId, null);
    } catch { this.publish(this.snapshot.previewId, '固定标签状态未能保存，当前标签仍保留。'); }
  }

  private publish(previewId: DocumentId | null, warning: string | null) {
    if (this.snapshot.previewId === previewId && this.snapshot.warning === warning) return;
    this.snapshot = { ...this.snapshot, previewId, warning,
      primaryId: this.snapshot.primaryId ?? this.registry.getSnapshot().activeId };
    this.listeners.forEach(listener => listener());
  }
}

export const tabs = new TabController(documents, closes);

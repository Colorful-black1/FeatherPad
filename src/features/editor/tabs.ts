import { files } from '../../bridge/files';
import type { DocumentId, FileRef, ResultEnvelope } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';
import { closes, type CloseChoice, type CloseCoordinator, type CloseResult } from './close';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface TabSnapshot { previewId: DocumentId | null; warning: string | null }
interface OpenTabResult { id: DocumentId; warning: string | null }
const preferenceKey = 'featherpad.tabs.pins.v1';
const isPinnedPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32_767;

function browserStorage(): PreferenceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export class TabController {
  private snapshot: TabSnapshot = { previewId: null, warning: null };
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
    return this.enqueue(async () => this.registry.createUntitled());
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

  open(reference: FileRef, intent: 'preview' | 'pinned' = 'pinned', mode?: 'head-preview'): Promise<ResultEnvelope<OpenTabResult>> {
    return this.enqueue(async () => {
      const result = await this.openFile(reference, mode);
      if (!result.ok) return result;
      const existing = this.registry.getDocument(result.value.documentId);
      const previousId = this.snapshot.previewId;
      const previousVersion = previousId ? this.registry.getDocument(previousId)?.summary.version : undefined;
      const id = this.registry.openDocument(result.value);
      if (existing) {
        if (intent === 'pinned') this.pin(id);
        return { ok: true, value: { id, warning: this.snapshot.warning } };
      }
      if (intent === 'pinned' || this.pinnedPaths.has(result.value.metadata.displayPath)) this.pin(id);
      else {
        if (previousId) this.pin(previousId);
        this.previewVersion = this.registry.getDocument(id)!.summary.version;
        this.publish(id, this.snapshot.warning);
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
    const path = this.registry.getDocument(id)?.summary.displayPath;
    const result = await this.closing.close(id, version, choice);
    if (result.ok && result.value.closed && path) {
      if (!this.registry.getSnapshot().documents.some(document => document.displayPath === path && document.id !== this.snapshot.previewId)) this.pinnedPaths.delete(path);
      this.persist();
    }
    return result;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const scheduled = this.pending.then(run, run);
    this.pending = scheduled.then(() => undefined, () => undefined);
    return scheduled;
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
    this.snapshot = { previewId, warning };
    this.listeners.forEach(listener => listener());
  }
}

export const tabs = new TabController(documents, closes);

import type { DocumentId } from '../../shared/contracts/files';
import { settings, type SettingsCoordinator } from '../desktop/settings';
import { documents, type DocumentRegistry } from './documents';
import { externalChanges, type ExternalChanges } from './external-changes';
import { saves, type SaveCoordinator } from './save';

interface PausedSave { message: string; revision: string; savedVersion: number }

export class AutoSaveCoordinator {
  private readonly timers = new Map<DocumentId, { version: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly active = new Set<DocumentId>();
  private paused: ReadonlyMap<DocumentId, PausedSave> = new Map();
  private readonly listeners = new Set<() => void>();
  private cleanup: (() => void) | null = null;

  constructor(private readonly registry: DocumentRegistry,
    private readonly preferences: Pick<SettingsCoordinator, 'subscribe' | 'getSnapshot'>,
    private readonly saving: Pick<SaveCoordinator, 'autoSave'>,
    private readonly external: Pick<ExternalChanges, 'subscribe' | 'getSnapshot'>,
    private readonly modalOpen = () => typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.paused;

  start(): () => void {
    if (this.cleanup) return () => this.stop();
    const unsubscribes = [this.registry.subscribe(this.sync), this.preferences.subscribe(this.sync), this.external.subscribe(this.sync)];
    if (typeof document !== 'undefined') {
      document.addEventListener('focusin', this.sync);
      document.addEventListener('close', this.sync, true);
    }
    this.cleanup = () => {
      unsubscribes.forEach(unsubscribe => unsubscribe());
      if (typeof document !== 'undefined') {
        document.removeEventListener('focusin', this.sync);
        document.removeEventListener('close', this.sync, true);
      }
    };
    this.sync();
    return () => this.stop();
  }

  stop() {
    this.cleanup?.(); this.cleanup = null;
    for (const id of this.timers.keys()) this.cancel(id);
  }

  retry(id: DocumentId) { this.clearPause(id); this.sync(); }

  private enabled() {
    const snapshot = this.preferences.getSnapshot();
    return snapshot.draft === null && snapshot.settings.autoSave && !this.modalOpen();
  }

  private eligible(id: DocumentId) {
    const item = this.registry.getDocument(id);
    return !!item?.source && item.summary.dirty && !item.summary.readOnlyReason && !item.summary.missing
      && !item.fragment && !item.summary.closing && !item.summary.hotExitFrozen && !item.releaseUncertain;
  }

  private readonly sync = () => {
    if (!this.cleanup) return;
    for (const [id, paused] of this.paused) {
      const item = this.registry.getDocument(id);
      if (!item || !item.summary.dirty || (item.source && (item.source.metadata.diskRevision !== paused.revision
        || item.savedVersion !== paused.savedVersion))) this.clearPause(id);
    }
    const enabled = this.enabled();
    for (const id of this.timers.keys()) {
      if (!enabled || !this.eligible(id) || this.paused.has(id)) this.cancel(id);
    }
    if (!enabled) return;
    for (const summary of this.registry.getSnapshot().documents) {
      const id = summary.id;
      if (!this.eligible(id) || this.active.has(id) || this.paused.has(id)) continue;
      const status = this.external.getSnapshot().get(id);
      if (status && status.kind !== 'reloaded') { this.pause(id, status.message); continue; }
      if (this.timers.get(id)?.version === summary.version) continue;
      this.cancel(id);
      this.timers.set(id, { version: summary.version, timer: setTimeout(() => {
        this.timers.delete(id);
        void this.save(id);
      }, 1500) });
    }
  };

  private async save(id: DocumentId) {
    const allowed = () => !!this.cleanup && this.enabled() && this.eligible(id) && !this.paused.has(id)
      && (!this.external.getSnapshot().has(id) || this.external.getSnapshot().get(id)?.kind === 'reloaded');
    if (!allowed()) return;
    this.active.add(id);
    try {
      const result = await this.saving.autoSave(id, allowed);
      if (!result.ok) this.pause(id, result.error.message);
    } finally {
      this.active.delete(id);
      this.sync();
    }
  }

  private pause(id: DocumentId, message: string) {
    this.cancel(id);
    const item = this.registry.getDocument(id);
    if (!item?.source || this.paused.get(id)?.message === message) return;
    this.paused = new Map(this.paused).set(id, { message, revision: item.source.metadata.diskRevision, savedVersion: item.savedVersion });
    this.listeners.forEach(listener => listener());
  }

  private clearPause(id: DocumentId) {
    if (!this.paused.has(id)) return;
    const next = new Map(this.paused); next.delete(id); this.paused = next;
    this.listeners.forEach(listener => listener());
  }

  private cancel(id: DocumentId) {
    const pending = this.timers.get(id);
    if (pending) clearTimeout(pending.timer);
    this.timers.delete(id);
  }
}

export const autoSaves = new AutoSaveCoordinator(documents, settings, saves, externalChanges);

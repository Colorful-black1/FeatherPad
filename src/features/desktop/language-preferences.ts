import type { DocumentId, ResultEnvelope } from '../../shared/contracts/files';
import type { JsonValue } from '../../shared/contracts/settings';
import { documents, type DocumentRegistry, type DocumentSummary } from '../editor/documents';
import { languageIds, type LanguageId } from '../editor/editor-language';
import { settings, type SettingsCoordinator } from './settings';
import { languagePreferencesSetting } from './settings-schema';

interface LanguagePreference { key: string; languageId: LanguageId }
interface Binding { identity: string; generation: number }
type Target = Pick<DocumentSummary, 'id' | 'displayPath'>;
const maximumEntries = 128;
const invalid = () => new Error('语言偏好无效或已达到容量限制；原数据已保留。');

export function readLanguagePreferences(raw: JsonValue | undefined): LanguagePreference[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 2 || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)
    || raw.entries.length > maximumEntries || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 16_384) throw invalid();
  const seen = new Set<string>();
  return raw.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
      || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key) || seen.has(entry.key)
      || typeof entry.languageId !== 'string' || !languageIds.includes(entry.languageId as LanguageId)) throw invalid();
    seen.add(entry.key);
    return { key: entry.key, languageId: entry.languageId as LanguageId };
  });
}

export async function languagePreferenceKey(target: Target): Promise<string> {
  const identity = target.displayPath === null ? `document:${target.id}` : `path:${target.displayPath.replaceAll('/', '\\')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class LanguagePreferenceCoordinator {
  private readonly bindings = new Map<DocumentId, Binding>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopListeners: (() => void) | null = null;
  private report: (message: string) => void = () => {};
  private storedFingerprint: string | undefined;

  constructor(private readonly registry: DocumentRegistry, private readonly preferences: SettingsCoordinator,
    private readonly keyFor: typeof languagePreferenceKey = languagePreferenceKey) {}

  start(report: (message: string) => void): () => void {
    if (this.stopListeners) return () => this.stop();
    this.report = report;
    const stopDocuments = this.registry.subscribe(this.syncDocuments);
    const stopSettings = this.preferences.subscribe(() => this.syncSettings());
    this.stopListeners = () => { stopDocuments(); stopSettings(); };
    this.syncSettings();
    return () => this.stop();
  }

  stop() {
    this.stopListeners?.(); this.stopListeners = null;
    this.bindings.clear(); this.storedFingerprint = undefined;
    this.report = () => {};
  }

  choose(id: DocumentId, selection: 'auto' | LanguageId): Promise<void> {
    const document = this.registry.getDocument(id);
    if (!document || document.source?.mode === 'text-preview') return Promise.resolve();
    const target = { id, displayPath: document.summary.displayPath };
    const binding = this.bindings.get(id);
    if (binding) binding.generation++;
    this.registry.setLanguage(id, selection);
    return this.enqueue(() => this.persist(target, selection));
  }

  async flush(): Promise<void> {
    // A write acknowledgment can enqueue a restore; wait until the queue stays idle.
    let current: Promise<unknown>;
    do { current = this.queue; await current; } while (current !== this.queue);
  }

  private syncSettings() {
    if (this.preferences.getSnapshot().version === null) return;
    const fingerprint = JSON.stringify(this.preferences.getSnapshot().user[languagePreferencesSetting]);
    const previous = new Set(this.bindings.keys());
    this.syncDocuments();
    if (fingerprint === this.storedFingerprint) return;
    this.storedFingerprint = fingerprint;
    for (const id of previous) {
      const binding = this.bindings.get(id);
      if (binding && this.registry.getDocument(id)?.summary.languageSource === 'auto') this.restore(id, binding);
    }
  }

  private readonly syncDocuments = () => {
    if (this.preferences.getSnapshot().version === null) return;
    const ids = new Set<DocumentId>();
    for (const summary of this.registry.getSnapshot().documents) {
      ids.add(summary.id);
      const document = this.registry.getDocument(summary.id)!;
      const identity = JSON.stringify([summary.displayPath, document.source?.mode]);
      if (this.bindings.get(summary.id)?.identity === identity) continue;
      const binding = { identity, generation: 0 };
      this.bindings.set(summary.id, binding);
      if (document.source?.mode === 'text-preview') continue;
      if (summary.languageSource === 'manual') {
        const target = { id: summary.id, displayPath: summary.displayPath };
        void this.enqueue(() => this.persist(target, summary.languageId));
      } else this.restore(summary.id, binding);
    }
    for (const id of this.bindings.keys()) if (!ids.has(id)) this.bindings.delete(id);
  };

  private restore(id: DocumentId, binding: Binding) {
    const document = this.registry.getDocument(id);
    if (!document || document.source?.mode === 'text-preview') return;
    const target = { id, displayPath: document.summary.displayPath };
    const generation = binding.generation;
    void this.enqueue(async () => {
      const key = await this.keyFor(target);
      if (this.bindings.get(id) !== binding || binding.generation !== generation
        || this.registry.getDocument(id)?.summary.languageSource !== 'auto') return;
      const entries = readLanguagePreferences(this.preferences.getSnapshot().user[languagePreferencesSetting]);
      const selection = entries.find(entry => entry.key === key);
      if (selection) this.registry.setLanguage(id, selection.languageId);
    });
  }

  private async persist(target: Target, selection: 'auto' | LanguageId) {
    const key = await this.keyFor(target);
    const current = this.preferences.getSnapshot().user[languagePreferencesSetting];
    const existing = readLanguagePreferences(current).find(entry => entry.key === key);
    if (selection === 'auto' ? !existing : existing?.languageId === selection) return;
    const result: ResultEnvelope<unknown> = await this.preferences.updatePersistedValue(languagePreferencesSetting, raw => {
      const entries = readLanguagePreferences(raw).filter(entry => entry.key !== key);
      if (selection !== 'auto') entries.push({ key, languageId: selection });
      if (entries.length > maximumEntries) throw invalid();
      return { schemaVersion: 1, entries: entries.map(entry => ({ ...entry })) };
    });
    if (!result.ok) throw invalid();
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const scheduled = this.queue.then(run).catch(() => {
      this.report('语言选择未能持久化：原数据已保留，此修改仅本次生效。请核对设置容量或重新读取设置后再试。');
    });
    this.queue = scheduled;
    return scheduled;
  }
}

export const languagePreferences = new LanguagePreferenceCoordinator(documents, settings);

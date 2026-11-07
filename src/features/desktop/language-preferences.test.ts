import { expect, it, vi } from 'vitest';
import type { settingsBridge } from '../../bridge/settings';
import type { DocumentId, FileRef, OpenDocument, ResultEnvelope } from '../../shared/contracts/files';
import type { LoadedSettings, RawSettings } from '../../shared/contracts/settings';
import { DocumentRegistry } from '../editor/documents';
import { LanguagePreferenceCoordinator, languagePreferenceKey, readLanguagePreferences } from './language-preferences';
import { SettingsCoordinator } from './settings';
import { languagePreferencesSetting } from './settings-schema';

const ok = <T>(value: T): ResultEnvelope<T> => ({ ok: true, value });
const fixture = (path = 'E:\\fixture\\note.unknown', id: string = crypto.randomUUID()): OpenDocument => ({
  documentId: id as DocumentId, ref: { grantId: crypto.randomUUID() as FileRef['grantId'], relativePath: '' },
  metadata: { displayPath: path, sizeBytes: 7, modifiedAt: '2026-11-03T00:00:00Z',
    isReadOnly: false, diskRevision: 'a'.repeat(64) as OpenDocument['metadata']['diskRevision'] },
  format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
  content: { kind: 'text', text: 'private', newlineMap: { documentVersion: 0, endings: [] } },
});
const encoded = (key: string, languageId = 'java') => ({ schemaVersion: 1, entries: [{ key, languageId }] });

function setup(raw: RawSettings = {}, hash: typeof languagePreferenceKey = languagePreferenceKey) {
  let stored: LoadedSettings = { schemaVersion: 1, version: 1, revision: 'a'.repeat(64), settings: raw,
    warning: null };
  const bridge: typeof settingsBridge = {
    load: vi.fn(async () => ok(structuredClone(stored))),
    save: vi.fn(async request => {
      stored = { ...stored, version: stored.version + 1, revision: 'b'.repeat(64), settings: structuredClone(request.settings) };
      return ok({ version: stored.version, revision: stored.revision! });
    }),
    workspace: vi.fn(), fonts: vi.fn(),
  };
  const preferences = new SettingsCoordinator(bridge);
  const registry = new DocumentRegistry();
  const coordinator = new LanguagePreferenceCoordinator(registry, preferences, hash);
  const report = vi.fn();
  coordinator.start(report);
  return { coordinator, registry, preferences, bridge, report, stored: () => stored,
    external: (settings: RawSettings) => { stored = { ...stored, settings, version: stored.version + 1, revision: 'c'.repeat(64) }; } };
}

it('uses separate hash domains without conflating case-sensitive or Unicode-distinct paths', async () => {
  const id = crypto.randomUUID() as DocumentId;
  const targets = [null, 'E:\\fixture\\A.txt', 'E:\\fixture\\a.txt', 'E:\\fixture\\é.txt', 'E:\\fixture\\é.txt'];
  const keys = await Promise.all(targets.map(displayPath => languagePreferenceKey({ id, displayPath })));
  expect(new Set(keys).size).toBe(targets.length);
  for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(await languagePreferenceKey({ id, displayPath: 'E:/fixture/A.txt' })).toBe(keys[1]);
});

it('restores a closed file under its new logical ID and auto removes the persistent override', async () => {
  const app = setup(); await app.preferences.load();
  const opened = fixture(); const id = app.registry.openDocument(opened);
  await app.coordinator.choose(id, 'java'); await app.coordinator.flush();
  expect(app.registry.getDocument(id)?.summary).toMatchObject({ languageId: 'java', languageSource: 'manual', dirty: false });
  expect(app.registry.beginClose(id, 0)).toMatchObject({ ok: true });
  expect(app.registry.removeClosed(id, 0)).toMatchObject({ ok: true });
  const reopened = app.registry.openDocument(fixture(opened.metadata.displayPath));
  await app.coordinator.flush();
  expect(app.registry.getDocument(reopened)?.summary.languageId).toBe('java');
  await app.coordinator.choose(reopened, 'auto');
  expect(readLanguagePreferences(app.stored().settings[languagePreferencesSetting])).toEqual([]);
  expect(app.registry.getDocument(reopened)?.summary).toMatchObject({ languageSource: 'auto', languageId: 'plaintext' });
  expect(JSON.stringify(app.stored().settings)).not.toContain('private');
  expect(JSON.stringify(app.stored().settings)).not.toContain('fixture');
  expect(app.report).not.toHaveBeenCalled();
});

it('restores documents opened before settings finish loading', async () => {
  const opened = fixture('E:\\fixture\\early.txt');
  const key = await languagePreferenceKey({ id: opened.documentId, displayPath: opened.metadata.displayPath });
  const app = setup({ [languagePreferencesSetting]: encoded(key, 'json') });
  const id = app.registry.openDocument(opened);
  await app.preferences.load(); await app.coordinator.flush();
  expect(app.registry.getDocument(id)?.summary).toMatchObject({ languageId: 'json', languageSource: 'manual' });
  expect(app.bridge.save).not.toHaveBeenCalled();
});

it('ignores a delayed restore after a user explicitly chooses auto', async () => {
  let release!: (key: string) => void;
  const app = setup({ [languagePreferencesSetting]: encoded('a'.repeat(64)) },
    vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }))
      .mockResolvedValue('a'.repeat(64)));
  await app.preferences.load(); const id = app.registry.openDocument(fixture());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const choice = app.coordinator.choose(id, 'auto');
  release('a'.repeat(64)); await choice; await app.coordinator.flush();
  expect(app.registry.getDocument(id)?.summary).toMatchObject({ languageSource: 'auto', languageId: 'plaintext' });
  expect(readLanguagePreferences(app.stored().settings[languagePreferencesSetting])).toEqual([]);
});

it('does not apply an old restore to a closed document or its replacement', async () => {
  let release!: (key: string) => void;
  const app = setup({ [languagePreferencesSetting]: encoded('a'.repeat(64)) },
    vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; })).mockResolvedValue('b'.repeat(64)));
  await app.preferences.load(); const opened = fixture(); const id = app.registry.openDocument(opened);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  app.registry.beginClose(id, 0); app.registry.removeClosed(id, 0);
  app.registry.openDocument(fixture('E:\\fixture\\other.txt', id));
  release('a'.repeat(64)); await app.coordinator.flush();
  expect(app.registry.getDocument(id)?.summary).toMatchObject({ languageId: 'plaintext', languageSource: 'auto' });
});

it('merges language choices with font, history and a concurrently updated language map', async () => {
  const app = setup({ future: { keep: true } }); await app.preferences.load();
  const id = app.registry.openDocument(fixture()); await app.coordinator.flush();
  vi.mocked(app.bridge.save).mockImplementationOnce(async () => {
    app.external({ future: { keep: true }, [languagePreferencesSetting]: encoded('d'.repeat(64), 'sql') });
    return { ok: false, error: { code: 'CONFLICT', message: 'external', retryable: false } };
  });
  await app.coordinator.choose(id, 'java');
  await Promise.all([app.preferences.setFontSize(18),
    app.preferences.updatePersistedValue('recentHistoryItems', { schemaVersion: 1, entries: [] })]);
  await app.coordinator.flush();
  const stored = app.stored().settings;
  expect(stored).toMatchObject({ future: { keep: true }, fontSize: 18, recentHistoryItems: { entries: [] } });
  expect(readLanguagePreferences(stored[languagePreferencesSetting]).map(entry => entry.languageId).sort()).toEqual(['java', 'sql']);
  expect(app.report).not.toHaveBeenCalled();
});

it('carries a manual choice across a renamed path without persisting every text transaction', async () => {
  const app = setup(); await app.preferences.load(); const id = app.registry.openDocument(fixture());
  await app.coordinator.choose(id, 'sql');
  const displayPath = 'E:\\fixture\\renamed.java';
  app.registry.applyRenamedPaths([{ documentId: id, ref: { grantId: crypto.randomUUID() as FileRef['grantId'], relativePath: '' }, displayPath }]);
  await app.coordinator.flush();
  const renamedKey = await languagePreferenceKey({ id, displayPath });
  expect(readLanguagePreferences(app.stored().settings[languagePreferencesSetting])).toContainEqual({ key: renamedKey, languageId: 'sql' });
  const saves = vi.mocked(app.bridge.save).mock.calls.length;
  const doc = app.registry.getDocument(id)!;
  app.registry.commit(id, [doc.state.update({ changes: { from: 0, insert: 'typed' } })]);
  await app.coordinator.flush();
  expect(app.bridge.save).toHaveBeenCalledTimes(saves);
});

it('preserves malformed, future and full preference records and reports persistence failures', async () => {
  const full = { schemaVersion: 1, entries: Array.from({ length: 128 }, (_, index) => ({
    key: index.toString(16).padStart(64, '0'), languageId: 'java',
  })) };
  for (const raw of [{ schemaVersion: 2, entries: [] }, { ...encoded('a'.repeat(64)), extra: true }, full]) {
    const app = setup({ [languagePreferencesSetting]: raw }); await app.preferences.load();
    const id = app.registry.openDocument(fixture()); await app.coordinator.choose(id, 'sql'); await app.coordinator.flush();
    expect(app.stored().settings[languagePreferencesSetting]).toEqual(raw);
    expect(app.registry.getDocument(id)?.summary.languageId).toBe('sql');
    expect(app.bridge.save).not.toHaveBeenCalled(); expect(app.report).toHaveBeenCalled();
  }
  expect(() => readLanguagePreferences({ schemaVersion: 1, entries: [
    { key: 'a'.repeat(64), languageId: 'java' }, { key: 'a'.repeat(64), languageId: 'json' },
  ] })).toThrow();
  const app = setup(); await app.preferences.load(); const id = app.registry.createUntitled();
  vi.mocked(app.bridge.save).mockResolvedValueOnce({ ok: false, error: { code: 'DISK_FULL', message: 'full', retryable: false } });
  await app.coordinator.choose(id, 'java');
  expect(app.stored().settings[languagePreferencesSetting]).toBeUndefined();
  expect(app.registry.getDocument(id)?.summary.languageSource).toBe('manual'); expect(app.report).toHaveBeenCalled();
});

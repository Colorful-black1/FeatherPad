import { afterEach, expect, it, vi } from 'vitest';
import type { FileRef, ResultEnvelope, SaveAsAck, SaveAsRequest } from '../../shared/contracts/files';
import type { LoadedSettings, RawSettings, SavedSettings, WorkspaceSettings } from '../../shared/contracts/settings';
import type { settingsBridge } from '../../bridge/settings';
import { SettingsCoordinator } from './settings';
import { mergeSettings } from './settings-schema';
import { WorkspaceStore } from '../workspace/store';
import { writeRecentHistory, type RecentEntry } from '../workspace/recent';

const revision = (letter: string) => letter.repeat(64);
const ok = <T>(value: T): ResultEnvelope<T> => ({ ok: true, value });
function loaded(settings: RawSettings = {}, version = 0): LoadedSettings {
  return { schemaVersion: 1, version, revision: version === 0 ? null : revision('a'), settings,
    warning: null, recoveryCopies: [] };
}
function setup(raw: RawSettings = {}, version = 0) {
  const bridge = {
    load: vi.fn<typeof settingsBridge.load>(async () => ok(loaded(raw, version))),
    save: vi.fn<typeof settingsBridge.save>(async request => ok({ version: request.expectedVersion + 1, revision: revision('b') })),
    restore: vi.fn<typeof settingsBridge.restore>(async request => ok({ version: request.expectedVersion + 1, revision: revision('c') })),
    workspace: vi.fn<typeof settingsBridge.workspace>(async () => ok({ settings: {}, revision: null, warning: null })),
    fonts: vi.fn<typeof settingsBridge.fonts>(async () => ok({ families: ['Consolas', 'Arial'], truncated: false })),
  };
  const exporter = vi.fn(async (request: SaveAsRequest): Promise<ResultEnvelope<SaveAsAck>> => ok({
    documentId: request.documentId, ref: { grantId: crypto.randomUUID() as FileRef['grantId'], relativePath: '' },
    metadata: { displayPath: 'E:\\fixtures\\settings.json', diskRevision: revision('c') as SaveAsAck['metadata']['diskRevision'],
      sizeBytes: request.text.length, modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false },
    ack: { documentVersion: request.documentVersion, diskRevision: revision('c') as SaveAsAck['ack']['diskRevision'],
      sizeBytes: request.text.length, savedAt: '2026-11-02T00:00:00Z' },
  }));
  const coordinator = new SettingsCoordinator(bridge, exporter);
  return { coordinator, bridge, exporter };
}
afterEach(() => vi.unstubAllGlobals());

it('coalesces in-flight font changes and serializes history without reverting the latest visible size', async () => {
  const { coordinator, bridge } = setup({ fontSize: 14, future: 'retained' }, 1);
  await coordinator.load();
  let acknowledge!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const first = coordinator.setFontSize(15);
  await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
  const second = coordinator.setFontSize(16);
  const latest = coordinator.setFontSize(17);
  const history = coordinator.updatePersistedValue('recentHistoryItems', { schemaVersion: 1, entries: [] });
  expect(second).toBe(first); expect(latest).toBe(first);
  expect(coordinator.getSnapshot().settings.fontSize).toBe(17);
  const flush = coordinator.flushFontSize();
  acknowledge(ok({ version: 2, revision: revision('b') }));
  expect(await flush).toMatchObject({ ok: true });
  expect(await history).toMatchObject({ ok: true });
  expect(bridge.save.mock.calls.map(([request]) => [request.expectedVersion, request.settings.fontSize]))
    .toEqual([[1, 15], [2, 17], [3, 17]]);
  expect(coordinator.getSnapshot()).toMatchObject({ version: 4, settings: { fontSize: 17 },
    user: { fontSize: 17, future: 'retained', recentHistoryItems: { schemaVersion: 1, entries: [] } }, session: {} });
});

it('rebases a settings preview opened during a font save without overwriting its newer edits', async () => {
  const { coordinator, bridge } = setup({ fontSize: 14, theme: 'light' }, 1);
  await coordinator.load();
  let acknowledge!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const saving = coordinator.setFontSize(15);
  await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
  coordinator.beginPreview(); coordinator.setPreview('fontSize', 20); coordinator.setPreview('theme', 'dark');
  acknowledge(ok({ version: 2, revision: revision('b') }));
  expect(await saving).toMatchObject({ ok: true });
  expect(coordinator.getSnapshot()).toMatchObject({ user: { fontSize: 15, theme: 'light' },
    draft: { fontSize: 20, theme: 'dark' }, settings: { fontSize: 20, theme: 'dark' } });
  coordinator.cancelPreview();
  expect(coordinator.getSnapshot().settings.fontSize).toBe(15);
});

it('font conflicts keep the session size and never retry an external settings overwrite', async () => {
  const { coordinator, bridge } = setup({ fontSize: 14 }, 1); await coordinator.load();
  bridge.save.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '配置已变化', retryable: false } });
  expect(await coordinator.setFontSize(19)).toMatchObject({ ok: false });
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(coordinator.getSnapshot()).toMatchObject({ version: 1, user: { fontSize: 14 }, settings: { fontSize: 19 } });
  expect(coordinator.getSnapshot().error).toContain('仅本次生效');
});

it('reconciles an unknown font write by exact readback and rejects a stale acknowledgment', async () => {
  const { coordinator, bridge } = setup({ fontSize: 14 }, 1); await coordinator.load();
  bridge.save.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'unknown', retryable: false } });
  bridge.load.mockResolvedValueOnce(ok({ ...loaded({ fontSize: 18 }, 2), revision: revision('b') }));
  expect(await coordinator.setFontSize(18)).toMatchObject({ ok: true });
  expect(bridge.save).toHaveBeenCalledTimes(1);
  let acknowledge!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const saving = coordinator.setFontSize(19);
  await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(2));
  bridge.load.mockResolvedValueOnce(ok(loaded({ fontSize: 21 }, 4)));
  await coordinator.load();
  acknowledge(ok({ version: 3, revision: revision('c') }));
  expect(await saving).toMatchObject({ ok: false });
  expect(coordinator.getSnapshot()).toMatchObject({ version: 4, user: { fontSize: 21 }, settings: { fontSize: 19 } });
});

it('invalid font sizes never change the session or call storage', async () => {
  const { coordinator, bridge } = setup({ fontSize: 14 }); await coordinator.load();
  for (const size of [7, 41, 14.5, Number.NaN]) expect(await coordinator.setFontSize(size)).toMatchObject({ ok: false });
  expect(bridge.save).not.toHaveBeenCalled();
  expect(coordinator.getSnapshot()).toMatchObject({ settings: { fontSize: 14 }, session: {} });
});

it('previews changes instantly and cancellation restores the user and temporary session choices', async () => {
  const { coordinator } = setup({ theme: 'light', fontSize: 14, future: true });
  await coordinator.load(); coordinator.setSession('theme', 'dark');
  coordinator.beginPreview(); coordinator.setPreview('theme', 'system'); coordinator.setPreview('fontSize', 20);
  expect(coordinator.getSnapshot().settings).toMatchObject({ theme: 'system', fontSize: 20 });
  coordinator.cancelPreview();
  expect(coordinator.getSnapshot().settings).toMatchObject({ theme: 'dark', fontSize: 14 });
  expect(coordinator.getSnapshot().user.future).toBe(true);
});

it('a late save only commits its captured configuration and leaves a newer preview unsaved', async () => {
  const { coordinator, bridge } = setup(); await coordinator.load();
  coordinator.beginPreview(); coordinator.setPreview('fontSize', 18);
  let done!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const save = coordinator.save(); coordinator.setPreview('fontSize', 20);
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  done(ok({ version: 1, revision: revision('b') })); expect(await save).toMatchObject({ ok: true });
  expect(coordinator.getSnapshot().user.fontSize).toBe(18);
  expect(coordinator.getSnapshot().draft?.fontSize).toBe(20);
  expect(coordinator.getSnapshot().settings.fontSize).toBe(20);
  expect(coordinator.getSnapshot().message).toContain('还有新的预览');
});

it('conflict reload preserves local edits and merges newly discovered foreign fields before another save', async () => {
  const { coordinator, bridge } = setup({ theme: 'light', future: 1 }, 1);
  await coordinator.load(); coordinator.beginPreview(); coordinator.setPreview('fontSize', 18);
  bridge.save.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'changed', retryable: false } });
  expect(await coordinator.save()).toMatchObject({ ok: false });
  bridge.load.mockResolvedValueOnce(ok(loaded({ theme: 'dark', future: 2, newer: true }, 2)));
  await coordinator.load();
  expect(coordinator.getSnapshot().draft).toEqual({ theme: 'dark', future: 2, newer: true, fontSize: 18 });
  await coordinator.save();
  expect(bridge.save.mock.calls[1]![0]).toMatchObject({ expectedVersion: 2,
    settings: { theme: 'dark', future: 2, newer: true, fontSize: 18 } });
});

it('an unknown write result is reconciled by reading the captured configuration instead of writing twice', async () => {
  const { coordinator, bridge } = setup(); await coordinator.load();
  coordinator.beginPreview(); coordinator.setPreview('theme', 'dark');
  bridge.save.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'unknown', retryable: false } });
  bridge.load.mockResolvedValueOnce(ok(loaded({ theme: 'dark' }, 1)));
  expect(await coordinator.save()).toMatchObject({ ok: true });
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(coordinator.getSnapshot()).toMatchObject({ version: 1, draft: null, user: { theme: 'dark' } });
});

it('storage failure leaves preview applied and reports session-only status without advancing the saved version', async () => {
  const { coordinator, bridge } = setup({ theme: 'light' }, 1); await coordinator.load();
  coordinator.beginPreview(); coordinator.setPreview('theme', 'dark');
  bridge.save.mockResolvedValueOnce({ ok: false, error: { code: 'DISK_FULL', message: '满盘', retryable: false } });
  expect(await coordinator.save()).toMatchObject({ ok: false });
  expect(coordinator.getSnapshot()).toMatchObject({ version: 1, settings: { theme: 'dark' }, user: { theme: 'light' } });
  expect(coordinator.getSnapshot().error).toContain('仅本次生效');
});

it('explicit session use applies a reset and keeps the persisted user values untouched', async () => {
  const { coordinator, bridge } = setup({ fontSize: 20, future: true }); await coordinator.load();
  coordinator.beginPreview(); coordinator.reset(['fontSize']); coordinator.usePreviewForSession();
  expect(coordinator.getSnapshot().settings.fontSize).toBe(14);
  expect(coordinator.getSnapshot().user.fontSize).toBe(20);
  expect(bridge.save).not.toHaveBeenCalled();
  coordinator.clearSession(); expect(coordinator.getSnapshot().settings.fontSize).toBe(20);
});

it('stale workspace results cannot apply a previous root and disallowed keys never become effective', async () => {
  const { coordinator, bridge } = setup();
  let done!: (value: ResultEnvelope<WorkspaceSettings>) => void;
  bridge.workspace.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  bridge.workspace.mockResolvedValueOnce(ok({ settings: { tabSize: 8, theme: 'dark', globalShortcut: { enabled: true } }, warning: null, revision: revision('b') }));
  const first = coordinator.reloadWorkspace({ grantId: 'old' as FileRef['grantId'], relativePath: '' });
  await coordinator.reloadWorkspace({ grantId: 'new' as FileRef['grantId'], relativePath: '' });
  done(ok({ settings: { tabSize: 2 }, revision: revision('a'), warning: null })); await first;
  expect(coordinator.getSnapshot().settings).toMatchObject({ tabSize: 8, theme: 'system' });
  expect(coordinator.getSnapshot().diagnostics.map(item => item.key)).toEqual(['theme', 'globalShortcut']);
});

it('native font inventory makes missing-font fallback visible and clears it for an installed name', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { coordinator } = setup();
  const stop = coordinator.start(new WorkspaceStore());
  await vi.waitFor(() => expect(coordinator.getSnapshot().fontWarning).toContain('未找到本机字体'));
  coordinator.beginPreview(); coordinator.setPreview('fontFamily', 'Consolas');
  expect(coordinator.getSnapshot().fontWarning).toBeNull(); stop();
});

it('unknown export results reuse the exact copy request and preserve the exported unknown fields', async () => {
  const { coordinator, exporter } = setup({ theme: 'dark', future: { retain: true } }); await coordinator.load();
  exporter.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'unknown', retryable: false } });
  expect(await coordinator.export()).toMatchObject({ ok: false });
  expect(await coordinator.export()).toMatchObject({ ok: true });
  expect(exporter.mock.calls[0]![0]).toBe(exporter.mock.calls[1]![0]);
  expect(exporter.mock.calls[0]![0].intent).toBe('copy');
  expect(JSON.parse(exporter.mock.calls[0]![0].text).settings.future).toEqual({ retain: true });
});

it('serializes recent history and settings writes without dropping either update', async () => {
  const { coordinator, bridge } = setup({ theme: 'light', future: 'retained' }, 1);
  await coordinator.load();
  coordinator.beginPreview();
  coordinator.setPreview('theme', 'dark');
  let acknowledge!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));

  const settingSave = coordinator.save();
  const entry: RecentEntry = {
    id: 'file:' + 'a'.repeat(64),
    kind: 'file',
    canonicalIdentity: 'a'.repeat(64),
    ref: { grantId: '11111111-1111-4111-8111-111111111111' as FileRef['grantId'], relativePath: '' },
    title: 'note.txt',
    displayPath: 'E:\\fixtures\\note.txt',
    lastOpenedAt: '2026-11-02T00:00:00.000Z',
  };
  const recentSave = coordinator.updatePersistedValue('recentHistoryItems', writeRecentHistory([entry]));
  await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
  expect(bridge.save.mock.calls[0]![0].settings).not.toHaveProperty('recentHistoryItems');

  acknowledge(ok({ version: 2, revision: revision('b') }));
  expect(await settingSave).toMatchObject({ ok: true });
  expect(await recentSave).toMatchObject({ ok: true });
  expect(bridge.save.mock.calls[1]![0]).toMatchObject({
    expectedVersion: 2,
    settings: {
      theme: 'dark',
      future: 'retained',
      recentHistoryItems: { schemaVersion: 1, entries: [entry] },
    },
  });
  expect(coordinator.getSnapshot().user).toMatchObject({
    theme: 'dark',
    future: 'retained',
    recentHistoryItems: { schemaVersion: 1, entries: [entry] },
  });
});

it('builds a settings request after an already queued recent history write', async () => {
  const { coordinator, bridge } = setup({ theme: 'light', future: 'retained' }, 1);
  await coordinator.load();
  coordinator.beginPreview();
  coordinator.setPreview('theme', 'dark');
  let acknowledge!: (value: ResultEnvelope<SavedSettings>) => void;
  bridge.save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const entry: RecentEntry = {
    id: 'file:' + 'b'.repeat(64),
    kind: 'file',
    canonicalIdentity: 'b'.repeat(64),
    ref: { grantId: '22222222-2222-4222-8222-222222222222' as FileRef['grantId'], relativePath: '' },
    title: 'queued.txt',
    displayPath: 'E:\\fixtures\\queued.txt',
    lastOpenedAt: '2026-11-02T00:00:01.000Z',
  };
  const recentHistory = writeRecentHistory([entry]);
  const recentSave = coordinator.updatePersistedValue('recentHistoryItems', recentHistory);
  const settingSave = coordinator.save();

  await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
  acknowledge(ok({ version: 2, revision: revision('b') }));
  expect(await recentSave).toMatchObject({ ok: true });
  expect(await settingSave).toMatchObject({ ok: true });
  expect(bridge.save.mock.calls[1]![0]).toMatchObject({
    expectedVersion: 2,
    settings: { theme: 'dark', future: 'retained', recentHistoryItems: recentHistory },
  });
  expect(coordinator.getSnapshot().user).toMatchObject({
    theme: 'dark',
    future: 'retained',
    recentHistoryItems: recentHistory,
  });
});

it('reserves recent history storage without treating it as an invalid preference', () => {
  const merged = mergeSettings({
    recentHistoryEnabled: false,
    recentHistoryItems: { schemaVersion: 1, entries: [] },
    future: true,
  });
  expect(merged.settings.recentHistoryEnabled).toBe(false);
  expect(merged.diagnostics.map(item => item.key)).toEqual(['future']);
});

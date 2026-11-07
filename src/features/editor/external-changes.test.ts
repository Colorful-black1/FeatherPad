import { afterEach, expect, it, vi } from 'vitest';
import type { DiskRevision, DocumentId, OpenDocument, ResultEnvelope, FileMetadata } from '../../shared/contracts/files';
import { isFilesystemChanged } from '../../bridge/external';
import { DocumentRegistry } from './documents';
import { ExternalChanges } from './external-changes';
import { SaveCoordinator } from './save';

const rev = (value: string) => value.repeat(64) as DiskRevision;
const ok = <T>(value: T): ResultEnvelope<T> => ({ ok: true, value });
function setup() {
  const registry = new DocumentRegistry();
  const id = crypto.randomUUID() as DocumentId;
  const source: OpenDocument = { documentId: id, ref: { grantId: crypto.randomUUID() as OpenDocument['ref']['grantId'], relativePath: '' },
    metadata: { diskRevision: rev('a'), displayPath: 'E:\\fixture\\test.txt', sizeBytes: 3, modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
    content: { kind: 'text', text: 'old', newlineMap: { documentVersion: 0, endings: [] } } };
  registry.openDocument(source);
  const disk: OpenDocument = { ...source, metadata: { ...source.metadata, diskRevision: rev('b') },
    content: { kind: 'text', text: 'disk', newlineMap: { documentVersion: 0, endings: [] } } };
  const saving = new SaveCoordinator(registry);
  const transport = { stat: vi.fn(async () => ok(disk.metadata)), snapshot: vi.fn(async (): Promise<ResultEnvelope<OpenDocument>> => ok(disk)),
    reload: vi.fn(async (): Promise<ResultEnvelope<OpenDocument>> => ok(disk)),
    start: vi.fn(async () => ok({ watchId: 'watch-fixture' })), stop: vi.fn(async () => ok({ stopped: true })),
    listen: vi.fn(async () => () => {}) };
  const recovery = { flush: vi.fn(async () => {
    const version = registry.getDocument(id)!.summary.version;
    registry.acknowledgeRecovery(id, version, crypto.randomUUID());
    return ok(null);
  }) };
  const changes = new ExternalChanges(registry, saving, recovery, transport);
  const edit = (text: string) => {
    const state = registry.getDocument(id)!.state;
    registry.commit(id, [state.update({ changes: { from: 0, to: state.doc.length, insert: text } })]);
  };
  return { registry, id, source, disk, saving, transport, recovery, changes, edit };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('automatically reloads a clean buffer, advances version and preserves cursor and document identity', async () => {
  const { registry, id, changes, transport } = setup();
  registry.restoreSessionState(id, [{ anchor: 2, head: 3 }], 0);
  await changes.check(id);
  expect(transport.reload).toHaveBeenCalledWith(id, rev('b'));
  expect(registry.getDocument(id)?.state.doc.toString()).toBe('disk');
  expect(registry.getDocument(id)?.summary).toMatchObject({ id, version: 1, dirty: false });
  expect(registry.getDocument(id)?.state.selection.main).toMatchObject({ anchor: 2, head: 3 });
  expect(registry.captureSave(id)).toMatchObject({ ok: true, value: { request: { expectedDiskRevision: rev('b'), documentVersion: 1 } } });
  expect(changes.getSnapshot().get(id)?.kind).toBe('reloaded');
});

it('keeps dirty text and undo state on an external modification', async () => {
  const { registry, id, edit, changes, transport } = setup();
  edit('my unsaved text');
  const state = registry.getDocument(id)!.state;
  await changes.check(id);
  expect(transport.reload).not.toHaveBeenCalled();
  expect(registry.getDocument(id)!.state).toBe(state);
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe(rev('a'));
  expect(changes.getSnapshot().get(id)).toMatchObject({ kind: 'changed', revision: rev('b') });
});

it('does not replace input typed during stat', async () => {
  const { registry, id, edit, changes, transport, disk } = setup();
  let done!: (result: ResultEnvelope<FileMetadata>) => void;
  transport.stat.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  const pending = changes.check(id);
  await Promise.resolve();
  edit('new input'); done(ok(disk.metadata));
  await pending;
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('new input');
  expect(transport.reload).not.toHaveBeenCalled();
});

it('does not replace input typed while a reload IPC is in flight', async () => {
  const { registry, id, edit, changes, transport, disk } = setup();
  let done!: (result: ResultEnvelope<OpenDocument>) => void;
  transport.reload.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  const pending = changes.check(id);
  await vi.waitFor(() => expect(transport.reload).toHaveBeenCalled());
  edit('late input'); done(ok(disk)); await pending;
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('late input');
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
  expect(changes.getSnapshot().get(id)?.kind).toBe('changed');
});

it('serializes checks after saves and uses the resulting saved baseline', async () => {
  const { registry, id, changes, saving, transport, source } = setup();
  let release!: () => void;
  const held = saving.exclusive<null>(id, () => new Promise(resolve => { release = () => resolve(ok(null)); }));
  const checked = changes.check(id);
  await Promise.resolve();
  expect(transport.stat).not.toHaveBeenCalled();
  transport.stat.mockResolvedValue(ok(source.metadata));
  release(); await held; await checked;
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('old');
  expect(transport.reload).not.toHaveBeenCalled();
});

it('protects a clean buffer whose source was deleted, retaining its ref and text for Save As', async () => {
  const { registry, id, changes, transport, source } = setup();
  transport.stat.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: '文件不存在', retryable: false } });
  await changes.check(id);
  expect(registry.getDocument(id)!.summary).toMatchObject({ missing: true, dirty: true, recoveryProtected: false });
  expect(registry.getDocument(id)!.source?.ref).toEqual(source.ref);
  expect(registry.captureSaveAs(id, 'save-as')).toMatchObject({ ok: true, value: { request: { text: 'old' } } });
  expect(changes.getSnapshot().get(id)?.kind).toBe('missing');
});

it('distinguishes permission/lock/unavailable errors from deletion without changing text', async () => {
  const { registry, id, changes, transport } = setup();
  transport.stat.mockResolvedValue({ ok: false, error: { code: 'PERMISSION_DENIED', message: '没有访问权限', retryable: false } });
  const state = registry.getDocument(id)!.state;
  await changes.check(id);
  expect(registry.getDocument(id)!.summary.missing).toBe(false);
  expect(registry.getDocument(id)!.state).toBe(state);
  expect(changes.getSnapshot().get(id)?.kind).toBe('unavailable');
});

it('requires draft protection before explicit dirty reload and preserves the source snapshot on failure', async () => {
  const { registry, id, changes, transport, recovery, edit } = setup();
  edit('unsaved');
  recovery.flush.mockResolvedValue({ ok: false, error: { code: 'DISK_FULL', message: '快照失败', retryable: false } });
  expect(await changes.reload(id, rev('b'))).toMatchObject({ ok: false, error: { code: 'DISK_FULL' } });
  expect(transport.reload).not.toHaveBeenCalled();
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('unsaved');
});

it('explicit dirty reload advances beyond the protected version and keeps recovery evidence', async () => {
  const { registry, id, changes, edit } = setup();
  edit('protected draft');
  expect(await changes.reload(id, rev('b'))).toMatchObject({ ok: true });
  expect(registry.getDocument(id)!.summary).toMatchObject({ dirty: false, version: 2 });
  expect(registry.getDocument(id)!.hasRecoveryData).toBe(true);
});

it('rejects stale reloading even after draft protection when newer input arrives', async () => {
  const { registry, id, changes, recovery, edit, transport } = setup();
  edit('draft');
  const protect = recovery.flush.getMockImplementation()!;
  recovery.flush.mockImplementation(async () => { const result = await protect(); edit('newer'); return result; });
  expect(await changes.reload(id, rev('b'))).toMatchObject({ ok: false });
  expect(transport.reload).not.toHaveBeenCalled();
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('newer');
});

it('does not mutate the buffer while obtaining a comparison snapshot', async () => {
  const { registry, id, changes, edit } = setup(); edit('draft');
  const state = registry.getDocument(id)!.state;
  expect(await changes.compare(id)).toMatchObject({ ok: true, value: { metadata: { diskRevision: rev('b') } } });
  expect(registry.getDocument(id)!.state).toBe(state);
});

it('validates bounded filesystem event payloads', () => {
  expect(isFilesystemChanged({ watchId: 'w', sequence: 1, entries: [], overflow: true })).toBe(true);
  expect(isFilesystemChanged({ watchId: 'w', sequence: -1, entries: [], overflow: true })).toBe(false);
  expect(isFilesystemChanged({ watchId: 'w', sequence: 1, entries: [{ ref: { grantId: 'g', relativePath: '../escape' }, kind: 'changed' }], overflow: true })).toBe(false);
});

it('checks all documents on focus and overflow, ignores another subscription, and releases watchers on stop', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { registry, changes, transport, source } = setup();
  registry.openDocument({ ...source, documentId: crypto.randomUUID() as DocumentId });
  transport.stat.mockResolvedValue(ok(source.metadata));
  const stop = changes.start();
  await vi.waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
  await changes.checkAll();
  const before = transport.stat.mock.calls.length;
  changes.receive({ watchId: 'other-watch', sequence: 1, entries: [], overflow: true });
  expect(transport.stat).toHaveBeenCalledTimes(before);
  changes.receive({ watchId: 'watch-fixture', sequence: 12, entries: [], overflow: true });
  await vi.waitFor(() => expect(transport.stat.mock.calls.length).toBeGreaterThanOrEqual(before + 2));
  await vi.waitFor(() => expect(transport.start).toHaveBeenCalledTimes(2));
  const after = transport.stat.mock.calls.length;
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(transport.stat.mock.calls.length).toBeGreaterThanOrEqual(after + 2));
  stop();
  expect(transport.stop).toHaveBeenCalledWith('watch-fixture');
  const stopped = transport.stat.mock.calls.length;
  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(transport.stat).toHaveBeenCalledTimes(stopped);
});

it('rechecks a notification arriving during a pending disk read', async () => {
  const { id, changes, transport, source } = setup();
  let done!: (value: ResultEnvelope<FileMetadata>) => void;
  transport.stat.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  transport.stat.mockResolvedValue(ok(source.metadata));
  const first = changes.check(id);
  await Promise.resolve();
  void changes.check(id);
  done(ok(source.metadata)); await first;
  await vi.waitFor(() => expect(transport.stat).toHaveBeenCalledTimes(2));
});

it('a stopped coordinator ignores delayed reload results', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { registry, id, changes, transport, disk } = setup();
  let done!: (value: ResultEnvelope<OpenDocument>) => void;
  transport.reload.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const pending = changes.check(id);
  await vi.waitFor(() => expect(transport.reload).toHaveBeenCalled());
  changes.stop(); done(ok(disk)); await pending;
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('old');
});

it('explicit overwrite binds the compared disk revision and leaves newer input dirty after its Ack', async () => {
  const { registry, id, edit } = setup(); edit('confirmed text');
  let done!: (value: ResultEnvelope<import('../../shared/contracts/files').SaveAck>) => void;
  const overwrite = vi.fn((request: import('../../shared/contracts/files').SaveRequest) => {
    expect(request.expectedDiskRevision).toBe(rev('b'));
    return new Promise<ResultEnvelope<import('../../shared/contracts/files').SaveAck>>(resolve => { done = resolve; });
  });
  const saving = new SaveCoordinator(registry, undefined, undefined, undefined, overwrite);
  const pending = saving.overwrite(id, rev('b'));
  await Promise.resolve(); edit('newer input');
  done(ok({ documentVersion: 1, diskRevision: rev('c'), savedAt: '2026-11-02T00:00:01Z', sizeBytes: 14 }));
  expect(await pending).toMatchObject({ ok: true });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('newer input');
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe(rev('c'));
});

it('unknown overwrite results replay the same request instead of sending newer text to disk', async () => {
  const { registry, id, edit } = setup(); edit('confirmed text');
  const overwrite = vi.fn(async (request: import('../../shared/contracts/files').SaveRequest): Promise<ResultEnvelope<import('../../shared/contracts/files').SaveAck>> =>
    ok({ documentVersion: request.documentVersion, diskRevision: rev('c'), savedAt: '2026-11-02T00:00:01Z', sizeBytes: 14 }));
  overwrite.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'unknown', retryable: false } });
  const saving = new SaveCoordinator(registry, undefined, undefined, undefined, overwrite);
  expect(await saving.overwrite(id, rev('b'))).toMatchObject({ ok: false }); edit('newer');
  expect(await saving.overwrite(id, rev('d'))).toMatchObject({ ok: true });
  expect(overwrite.mock.calls[0]![0]).toBe(overwrite.mock.calls[1]![0]);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('newer');
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
});

it('a stale or cancelled overwrite retains the buffer and baseline', async () => {
  const { registry, id, edit } = setup(); edit('draft');
  const overwrite = vi.fn(async (): Promise<ResultEnvelope<import('../../shared/contracts/files').SaveAck>> =>
    ({ ok: false, error: { code: 'CONFLICT', message: 'again changed', retryable: false } }));
  const saving = new SaveCoordinator(registry, undefined, undefined, undefined, overwrite);
  expect(await saving.overwrite(id, rev('b'))).toMatchObject({ ok: false });
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe(rev('a'));
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('draft');
});

it('saving an externally missing buffer asks for a destination without overwriting a reappearing source', async () => {
  const { registry, id, source } = setup(); registry.markExternalMissing(id);
  const normal = vi.fn();
  const destination = vi.fn(async (request: import('../../shared/contracts/files').SaveAsRequest) => ok({
    documentId: id, ref: source.ref, metadata: { ...source.metadata, diskRevision: rev('c') },
    ack: { documentVersion: request.documentVersion, diskRevision: rev('c'), savedAt: '2026-11-02T00:00:01Z', sizeBytes: 3 },
  }));
  const saving = new SaveCoordinator(registry, normal, undefined, destination);
  expect(await saving.save(id)).toMatchObject({ ok: true });
  expect(normal).not.toHaveBeenCalled();
  expect(destination).toHaveBeenCalledTimes(1);
  expect(registry.getDocument(id)!.summary).toMatchObject({ missing: false, dirty: false });
});

it('a successful focus stat does not hide a failed native listener subscription', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { id, changes, transport, source } = setup();
  transport.stat.mockResolvedValue(ok(source.metadata));
  transport.listen.mockRejectedValue(new Error('listener unavailable'));
  const stop = changes.start();
  await vi.waitFor(() => expect(changes.getSnapshot().get(id)?.message).toContain('文件监听不可用'));
  await changes.checkAll();
  expect(changes.getSnapshot().get(id)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('文件监听不可用') });
  stop();
});

it('a stale out-of-scope watch reference does not mark the open buffer unavailable', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { id, changes, transport, source } = setup();
  transport.stat.mockResolvedValue(ok(source.metadata));
  transport.start.mockResolvedValue({ ok: false, error: {
    code: 'OUT_OF_SCOPE', message: '文件不在已授权范围内，请重新选择。', retryable: false,
  } });
  const stop = changes.start();
  await vi.waitFor(() => expect(transport.start).toHaveBeenCalled());
  await changes.checkAll();
  expect(changes.getSnapshot().get(id)).toBeUndefined();
  stop();
});

it('a successful focus stat does not imply a failed filesystem watcher is healthy', async () => {
  vi.stubGlobal('window', new EventTarget());
  const { id, changes, transport, source } = setup();
  transport.stat.mockResolvedValue(ok(source.metadata));
  transport.start.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'watch failed', retryable: false } });
  const stop = changes.start();
  await vi.waitFor(() => expect(changes.getSnapshot().get(id)?.message).toContain('监听未建立'));
  await changes.checkAll();
  expect(changes.getSnapshot().get(id)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('watch failed') });
  stop();
});

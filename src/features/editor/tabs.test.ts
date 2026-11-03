import { expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { DiscardRecoveryRequest, DocumentId, FileRef, GrantId, OpenDocument, ResultEnvelope } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { SaveCoordinator } from './save';
import { CloseCoordinator } from './close';
import { TabController } from './tabs';

const reference = (name: string): FileRef => ({ grantId: name as GrantId, relativePath: '' });
function fixture(name: string): OpenDocument {
  return { documentId: name as DocumentId, ref: reference(name),
    metadata: { displayPath: `E:\\fixtures\\${name}.txt`, sizeBytes: name.length, modifiedAt: '2026-11-02T00:00:00Z',
      isReadOnly: false, diskRevision: 'a'.repeat(64) as OpenDocument['metadata']['diskRevision'] },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
    content: { kind: 'text', text: name, newlineMap: { documentVersion: 0, endings: [] } } };
}
function preferences() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
function setup(storage = preferences()) {
  const registry = new DocumentRegistry();
  const saving = new SaveCoordinator(registry);
  const release = vi.fn(async (): Promise<ResultEnvelope<{ released: boolean }>> => ({ ok: true, value: { released: true } }));
  const discard = vi.fn(async (request: DiscardRecoveryRequest) => ({ ok: true as const, value: { ...request, discarded: true as const } }));
  const closing = new CloseCoordinator(registry, saving, discard, release);
  const open = vi.fn(async (ref: FileRef): Promise<ResultEnvelope<OpenDocument>> => ({ ok: true, value: fixture(ref.grantId) }));
  const tabs = new TabController(registry, closing, open, storage);
  return { registry, tabs, open, release, storage };
}

it('replaces only the clean preview and releases its buffer while keeping one preview', async () => {
  const h = setup();
  await h.tabs.open(reference('a'), 'preview');
  expect(h.tabs.getSnapshot().previewId).toBe('a');
  await h.tabs.open(reference('b'), 'preview');
  expect(h.tabs.getSnapshot().previewId).toBe('b');
  expect(h.tabs.getSnapshot().primaryId).toBe('b');
  expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual(['b']);
  expect(h.release).toHaveBeenCalledTimes(1);
});

it('pins on the first edit and undo to clean never makes the tab replaceable again', async () => {
  const h = setup();
  await h.tabs.open(reference('a'), 'preview');
  const id = 'a' as DocumentId;
  const document = h.registry.getDocument(id)!;
  h.registry.commit(id, [document.state.update({ changes: { from: 0, insert: 'dirty ' } })]);
  expect(h.tabs.getSnapshot().previewId).toBeNull();
  const edited = h.registry.getDocument(id)!;
  undo({ state: edited.state, dispatch: transaction => { h.registry.commit(id, [transaction]); } });
  expect(h.registry.getDocument(id)?.summary.dirty).toBe(false);
  await h.tabs.open(reference('b'), 'preview');
  expect(h.registry.getDocument(id)?.state.doc.toString()).toBe('a');
  expect(h.registry.getSnapshot().documents).toHaveLength(2);
  expect(h.release).not.toHaveBeenCalled();
});

it('reopening a pinned document focuses its existing state without demoting it', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  const state = h.registry.getDocument('a' as DocumentId)!.state;
  await h.tabs.open(reference('a'), 'preview');
  expect(h.tabs.getSnapshot().previewId).toBeNull();
  expect(h.registry.getDocument('a' as DocumentId)?.state).toBe(state);
  await h.tabs.open(reference('b'), 'preview');
  expect(h.registry.getSnapshot().documents).toHaveLength(2);
});

it('focuses each newly opened pinned document while keeping earlier buffers retained', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  await h.tabs.open(reference('b'));
  expect(h.tabs.getSnapshot().primaryId).toBe('b');
  expect(h.registry.getSnapshot().activeId).toBe('b');
  expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual(['a', 'b']);
});

it('keeps an unsplit editor synchronized when the registry activates an existing document', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  await h.tabs.open(reference('b'));

  h.registry.activate('a' as DocumentId);
  expect(h.tabs.getSnapshot()).toMatchObject({ primaryId: 'a', secondaryId: null, focusedGroup: 'primary' });
});

it('serializes rapid open requests and ends with the last requested preview', async () => {
  const h = setup();
  const first = h.tabs.open(reference('a'), 'preview');
  const second = h.tabs.open(reference('b'), 'preview');
  const third = h.tabs.open(reference('c'), 'preview');
  await Promise.all([first, second, third]);
  expect(h.open.mock.calls.map(([ref]) => ref.grantId)).toEqual(['a', 'b', 'c']);
  expect(h.registry.getSnapshot().activeId).toBe('c');
  expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual(['c']);
});

it('keeps an old preview pinned if resource release fails and reports the retained buffer', async () => {
  const h = setup();
  await h.tabs.open(reference('a'), 'preview');
  h.release.mockResolvedValueOnce({ ok: false, error: { code: 'BUSY', message: 'Controlled busy lease', retryable: true } });
  const result = await h.tabs.open(reference('b'), 'preview');
  expect(result.ok && result.value.warning).toContain('原预览仍保留');
  expect(h.tabs.getSnapshot().previewId).toBe('b');
  expect(h.registry.getDocument('a' as DocumentId)?.state.doc.toString()).toBe('a');
  await h.tabs.open(reference('c'), 'preview');
  expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual(['a', 'c']);
});

it('persists only pin metadata across controller restarts and removes it on explicit close', async () => {
  const storage = preferences();
  const first = setup(storage);
  await first.tabs.open(reference('a'), 'preview');
  first.tabs.pin('a' as DocumentId);
  const stored = storage.values.values().next().value;
  expect(stored).toBe(JSON.stringify({ schemaVersion: 1, pinnedPaths: ['E:\\fixtures\\a.txt'] }));
  const next = setup(storage);
  expect(next.open).not.toHaveBeenCalled();
  await next.tabs.open(reference('a'), 'preview');
  expect(next.tabs.getSnapshot().previewId).toBeNull();
  await next.tabs.close('a' as DocumentId, 0, 'clean');
  const last = setup(storage);
  await last.tabs.open(reference('a'), 'preview');
  expect(last.tabs.getSnapshot().previewId).toBe('a');
});

it('stores a named untitled tab and follows native rename mappings without storing body or grants', async () => {
  const h = setup();
  const id = await h.tabs.createUntitled();
  const captured = h.registry.captureSaveAs(id, 'save-as');
  if (!captured.ok) throw new Error('Untitled snapshot unavailable');
  const metadata = fixture('named').metadata;
  h.registry.acknowledgeSaveAs(captured.value, { documentId: id, ref: reference('named'), metadata,
    ack: { documentVersion: 0, diskRevision: metadata.diskRevision, savedAt: metadata.modifiedAt, sizeBytes: metadata.sizeBytes } });
  h.registry.applyRenamedPaths([{ documentId: id, ref: reference('renamed'), displayPath: 'E:\\fixtures\\renamed.txt' }]);
  const raw = h.storage.values.values().next().value;
  expect(raw).toBe(JSON.stringify({ schemaVersion: 1, pinnedPaths: ['E:\\fixtures\\renamed.txt'] }));
});

it('focuses a newly created untitled document in the active editor group', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  const id = await h.tabs.createUntitled();
  expect(h.tabs.getSnapshot().primaryId).toBe(id);
  expect(h.registry.getSnapshot().activeId).toBe(id);
  expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual(['a', id]);
});

it('reports damaged preferences and write failure while retaining the opened document', async () => {
  const storage = preferences();
  storage.values.set('featherpad.tabs.pins.v1', '{broken');
  const h = setup(storage);
  expect(h.tabs.getSnapshot().warning).toContain('无法读取');
  storage.setItem = () => { throw new Error('private path must not be shown'); };
  await h.tabs.open(reference('a'));
  expect(h.tabs.getSnapshot().warning).toContain('未能保存');
  expect(h.tabs.getSnapshot().warning).not.toContain('private');
  expect(h.registry.getDocument('a' as DocumentId)?.state.doc.toString()).toBe('a');
});

it('keeps the old path pinned when another retained document still uses it after a rename', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  const retained = fixture('retained');
  retained.metadata.displayPath = fixture('a').metadata.displayPath;
  h.open.mockResolvedValueOnce({ ok: true, value: retained });
  await h.tabs.open(reference('retained'));
  h.registry.applyRenamedPaths([{ documentId: 'a' as DocumentId, ref: reference('renamed'), displayPath: 'E:\\fixtures\\renamed.txt' }]);
  const raw = h.storage.values.values().next().value;
  expect(raw && JSON.parse(raw).pinnedPaths).toEqual(['E:\\fixtures\\a.txt', 'E:\\fixtures\\renamed.txt']);
  const next = setup(h.storage);
  await next.tabs.open(reference('a'), 'preview');
  expect(next.tabs.getSnapshot().previewId).toBeNull();
});

it('supports two groups, repairs a closed primary group, reopens the latest closed tab and computes batch scopes', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  await h.tabs.open(reference('b'));
  await h.tabs.open(reference('c'));

  h.tabs.focusPrimary('a' as DocumentId);
  expect(h.tabs.split('b' as DocumentId)).toBe(true);
  expect(h.tabs.getSnapshot()).toMatchObject({ primaryId: 'a', secondaryId: 'b', focusedGroup: 'secondary' });
  expect(h.tabs.closeCandidates('others', 'b' as DocumentId)).toEqual(['a', 'c']);
  expect(h.tabs.closeCandidates('right', 'b' as DocumentId)).toEqual(['c']);
  expect(h.tabs.closeCandidates('clean', 'b' as DocumentId)).toEqual(['a', 'b', 'c']);

  const c = h.registry.getDocument('c' as DocumentId)!;
  h.registry.commit('c' as DocumentId, [c.state.update({ changes: { from: 0, insert: 'dirty ' } })]);
  expect(h.tabs.closeCandidates('clean', 'b' as DocumentId)).toEqual(['a', 'b']);

  h.tabs.focusPrimary('a' as DocumentId);
  const closed = await h.tabs.close('a' as DocumentId, 0, 'clean');
  expect(closed.ok && closed.value.closed).toBe(true);
  expect(h.tabs.getSnapshot()).toMatchObject({ primaryId: 'c', secondaryId: 'b', focusedGroup: 'primary' });

  await h.tabs.reopenLastClosed();
  expect(h.registry.getDocument('a' as DocumentId)).toBeDefined();
  expect(h.tabs.getSnapshot().recentlyClosed).toHaveLength(0);
});

it('allows the same document in both groups while keeping one registry buffer', async () => {
  const h = setup();
  await h.tabs.open(reference('a'));
  h.tabs.focusPrimary('a' as DocumentId);
  expect(h.tabs.split('a' as DocumentId)).toBe(true);
  expect(h.tabs.getSnapshot()).toMatchObject({ primaryId: 'a', secondaryId: 'a', focusedGroup: 'secondary' });
  expect(h.registry.getSnapshot().documents).toHaveLength(1);
  h.tabs.closeSplit();
  expect(h.tabs.getSnapshot()).toMatchObject({ primaryId: 'a', secondaryId: null, focusedGroup: 'primary' });
});

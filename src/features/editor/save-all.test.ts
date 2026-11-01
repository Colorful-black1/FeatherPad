import { expect, it } from 'vitest';
import type { DiskRevision, DocumentId, GrantId, ResultEnvelope, SaveAsAck, SaveAsRequest } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { SaveCoordinator } from './save';
import { SaveAllCoordinator } from './save-all';

function edit(registry: DocumentRegistry, id: DocumentId, text: string) {
  const state = registry.getDocument(id)!.state;
  expect(registry.commit(id, [state.update({ changes: { from: 0, to: state.doc.length, insert: text } })]).ok).toBe(true);
}

function draft(registry: DocumentRegistry, text: string) {
  const id = registry.createUntitled();
  edit(registry, id, text);
  return id;
}

function saved(request: SaveAsRequest): ResultEnvelope<SaveAsAck> {
  const diskRevision = `revision-${request.requestId}` as DiskRevision;
  const sizeBytes = new TextEncoder().encode(request.text).length;
  return { ok: true, value: { documentId: request.documentId,
    ref: { grantId: `grant-${request.requestId}` as GrantId, relativePath: '' },
    metadata: { displayPath: `${request.documentId}.txt`, sizeBytes, diskRevision,
      isReadOnly: false, modifiedAt: '2026-11-01T00:00:00Z' },
    ack: { documentVersion: request.documentVersion, diskRevision, sizeBytes, savedAt: '2026-11-01T00:00:00Z' } } };
}

it('saves dirty documents sequentially, reports the third failure, and continues independent items', async () => {
  const registry = new DocumentRegistry();
  registry.createUntitled(); // A clean empty draft is not part of this operation.
  const ids = ['first', 'second', 'third', 'fourth'].map(text => draft(registry, text));
  const requests: SaveAsRequest[] = [];
  let active = 0;
  const saver = new SaveCoordinator(registry, undefined, undefined, async request => {
    expect(active++).toBe(0);
    await Promise.resolve();
    requests.push(request);
    active--;
    return requests.length === 3 ? { ok: false, error: { code: 'DISK_FULL', message: 'controlled full disk', retryable: false } } : saved(request);
  });
  const batch = new SaveAllCoordinator(registry, saver);
  const stages: string[] = [];
  batch.subscribe(() => stages.push(batch.getSnapshot().items.map(item => item.status).join(',')));
  await batch.run();
  expect(requests.map(request => request.documentId)).toEqual(ids);
  expect(batch.getSnapshot().phase).toBe('finished');
  expect(batch.getSnapshot().items.map(item => item.status)).toEqual(['saved', 'saved', 'failed', 'saved']);
  expect(batch.getSnapshot().items[2]).toMatchObject({ error: { code: 'DISK_FULL' } });
  expect(ids.map(id => registry.getDocument(id)!.summary.dirty)).toEqual([false, false, true, false]);
  expect(registry.getDocument(ids[2]!)!.state.doc.toString()).toBe('third');
  expect(stages).toContain('saved,saved,saving,pending');
});

it('stops after a cancelled path chooser and retains all cancelled and unprocessed drafts', async () => {
  const registry = new DocumentRegistry();
  const ids = ['first', 'cancelled', 'unprocessed'].map(text => draft(registry, text));
  let calls = 0;
  const batch = new SaveAllCoordinator(registry, new SaveCoordinator(registry, undefined, undefined, async request => {
    return ++calls === 2 ? { ok: false, error: { code: 'CANCELLED', message: 'controlled cancellation', retryable: false } } : saved(request);
  }));
  await batch.run();
  expect(calls).toBe(2);
  expect(batch.getSnapshot().items.map(item => item.status)).toEqual(['saved', 'cancelled', 'unprocessed']);
  for (const id of ids.slice(1)) {
    expect(registry.getDocument(id)!.summary.dirty).toBe(true);
    expect(registry.getDocument(id)!.source).toBeNull();
  }
  batch.dismiss();
  expect(batch.getSnapshot()).toEqual({ phase: 'idle', items: [] });
});

it('waits for the in-flight result after stop, preserves newer input, and excludes new documents', async () => {
  const registry = new DocumentRegistry();
  const first = draft(registry, 'captured');
  const second = draft(registry, 'waiting');
  let release: ((result: ResultEnvelope<SaveAsAck>) => void) | undefined;
  let request: SaveAsRequest | undefined;
  const batch = new SaveAllCoordinator(registry, new SaveCoordinator(registry, undefined, undefined, captured => {
    request = captured;
    return new Promise(resolve => { release = resolve; });
  }));
  const pending = batch.run();
  await Promise.resolve();
  expect(request?.text).toBe('captured');
  await batch.run(); // Repeated activation cannot create another batch or picker.
  edit(registry, first, 'captured plus later input');
  const added = draft(registry, 'added during save');
  batch.cancel();
  batch.dismiss(); // A running transaction remains visible and cannot be discarded.
  expect(batch.getSnapshot().phase).toBe('cancelling');
  expect(registry.getDocument(first)!.source).toBeNull();
  release!(saved(request!));
  await pending;
  expect(batch.getSnapshot().items).toMatchObject([{ id: first, status: 'saved', version: 1 }, { id: second, status: 'unprocessed' }]);
  expect(batch.getSnapshot().items).toHaveLength(2);
  expect(registry.getDocument(first)!.summary.dirty).toBe(true);
  expect(registry.getDocument(first)!.state.doc.toString()).toBe('captured plus later input');
  expect(registry.getDocument(added)!.summary.dirty).toBe(true);
  expect(registry.getSnapshot().activeId).toBe(added);
});

it('skips a draft reverted to clean while waiting and captures later changes only when its turn starts', async () => {
  const registry = new DocumentRegistry();
  const first = draft(registry, 'first');
  const reverted = draft(registry, 'to undo');
  const later = draft(registry, 'old');
  const requests: SaveAsRequest[] = [];
  let release: (() => void) | undefined;
  const saver = new SaveCoordinator(registry, undefined, undefined, async request => {
    requests.push(request);
    if (requests.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return saved(request);
  });
  const batch = new SaveAllCoordinator(registry, saver);
  const pending = batch.run();
  await Promise.resolve();
  edit(registry, reverted, '');
  edit(registry, later, 'fresh when started');
  release!();
  await pending;
  expect(requests.map(request => request.documentId)).toEqual([first, later]);
  expect(requests[1]?.text).toBe('fresh when started');
  expect(batch.getSnapshot().items.map(item => item.status)).toEqual(['saved', 'unchanged', 'saved']);
});

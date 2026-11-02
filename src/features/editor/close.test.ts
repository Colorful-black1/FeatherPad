import { expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { undo, undoDepth } from '@codemirror/commands';
import type { DiscardRecoveryRequest, DiscardRecoveryResult, DocumentId, GrantId, OpenDocument, ResultEnvelope, SaveAck, SaveRequest } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { SaveCoordinator } from './save';
import { CloseCoordinator } from './close';

function setup() {
  const registry = new DocumentRegistry();
  const opened: OpenDocument = {
    documentId: crypto.randomUUID() as DocumentId, ref: { grantId: 'fixture' as GrantId, relativePath: '' },
    metadata: { displayPath: 'controlled.txt', diskRevision: '0'.repeat(64) as OpenDocument['metadata']['diskRevision'],
      sizeBytes: 3, modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'old', newlineMap: { documentVersion: 0, endings: [] } },
  };
  const id = registry.openDocument(opened);
  const save = vi.fn(async (request: SaveRequest): Promise<ResultEnvelope<SaveAck>> => ({ ok: true, value: {
    documentVersion: request.documentVersion, diskRevision: '1'.repeat(64) as OpenDocument['metadata']['diskRevision'],
    savedAt: opened.metadata.modifiedAt, sizeBytes: request.text.length,
  } }));
  const discard = vi.fn(async (request: DiscardRecoveryRequest): Promise<ResultEnvelope<DiscardRecoveryResult>> => ({ ok: true, value: { ...request, discarded: true } }));
  const release = vi.fn(async (): Promise<ResultEnvelope<{ released: boolean }>> => ({ ok: true, value: { released: true } }));
  const saving = new SaveCoordinator(registry, save);
  const closing = new CloseCoordinator(registry, saving, discard, release);
  const edit = (text = ' dirty') => {
    const document = registry.getDocument(id)!;
    registry.commit(id, [document.state.update({ changes: { from: document.state.doc.length, insert: text } })]);
    return registry.getDocument(id)!.summary.version;
  };
  return { registry, id, opened, edit, save, discard, release, saving, closing };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

it('cancels a dirty close without saving, discarding or releasing anything', async () => {
  const h = setup();
  const version = h.edit();
  expect(await h.closing.close(h.id, version, 'cancel')).toEqual({ ok: true, value: { closed: false } });
  expect(h.registry.getDocument(h.id)?.summary).toMatchObject({ dirty: true, closing: false, version });
  expect(h.save).not.toHaveBeenCalled();
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});

it.each(['DISK_FULL', 'READ_ONLY', 'CONFLICT', 'CANCELLED'] as const)('keeps the entire document when save-and-close returns %s', async code => {
  const h = setup();
  const version = h.edit();
  h.save.mockResolvedValue({ ok: false, error: { code, message: 'Controlled failure', retryable: false } });
  expect(await h.closing.close(h.id, version, 'save')).toMatchObject({ ok: false, error: { code } });
  expect(h.registry.getDocument(h.id)?.state.doc.toString()).toBe('old dirty');
  expect(h.registry.getDocument(h.id)?.summary).toMatchObject({ dirty: true, closing: false, version });
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});

it('never closes new input delivered while the closing save Ack is pending', async () => {
  const h = setup();
  const version = h.edit();
  const ack = deferred<ResultEnvelope<SaveAck>>();
  h.save.mockReturnValue(ack.promise);
  const pending = h.closing.close(h.id, version, 'save');
  await Promise.resolve();
  expect(h.save).toHaveBeenCalledTimes(1);
  h.edit(' newer');
  ack.resolve({ ok: true, value: { documentVersion: version, diskRevision: h.opened.metadata.diskRevision,
    savedAt: h.opened.metadata.modifiedAt, sizeBytes: 9 } });
  expect(await pending).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(h.registry.getDocument(h.id)?.state.doc.toString()).toBe('old dirty newer');
  expect(h.registry.getDocument(h.id)?.summary.dirty).toBe(true);
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});

it('waits for an existing save and runs discard/release in that document queue', async () => {
  const h = setup();
  const version = h.edit();
  const ack = deferred<ResultEnvelope<SaveAck>>();
  h.save.mockReturnValue(ack.promise);
  const saving = h.saving.save(h.id);
  const closing = h.closing.close(h.id, version, 'save');
  await Promise.resolve();
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
  ack.resolve({ ok: true, value: { documentVersion: version, diskRevision: h.opened.metadata.diskRevision,
    savedAt: h.opened.metadata.modifiedAt, sizeBytes: 9 } });
  expect((await saving).ok).toBe(true);
  expect(await closing).toEqual({ ok: true, value: { closed: true } });
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.discard).toHaveBeenCalledWith({ documentId: h.id, throughVersion: version });
  expect(h.release).toHaveBeenCalledWith(h.id);
  expect(h.registry.getDocument(h.id)).toBeUndefined();
});

it('honors a later explicit discard after an earlier queued save fails', async () => {
  const h = setup();
  const version = h.edit();
  h.save.mockResolvedValue({ ok: false, error: { code: 'DISK_FULL', message: 'Controlled full store', retryable: false } });
  const saving = h.saving.save(h.id);
  const closing = h.closing.close(h.id, version, 'discard');
  expect((await saving).ok).toBe(false);
  expect((await closing).ok).toBe(true);
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.registry.getDocument(h.id)).toBeUndefined();
});

it('fences editing only during final cleanup and retains a fresh recovery version on failure', async () => {
  const h = setup();
  const version = h.edit();
  const before = h.registry.getDocument(h.id)!;
  const savedText = before.savedText;
  const historyDepth = undoDepth(before.state);
  const cleanup = deferred<ResultEnvelope<DiscardRecoveryResult>>();
  h.discard.mockReturnValue(cleanup.promise);
  const pending = h.closing.close(h.id, version, 'discard');
  await Promise.resolve();
  const frozen = h.registry.getDocument(h.id)!;
  expect(frozen.state.facet(EditorState.readOnly)).toBe(true);
  expect(h.registry.commit(h.id, [frozen.state.update({ changes: { from: 0, insert: 'rejected' } })])).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(await h.closing.close(h.id, version, 'cancel')).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  cleanup.resolve({ ok: false, error: { code: 'BUSY', message: 'Controlled sharing failure after marking', retryable: true } });
  expect((await pending).ok).toBe(false);
  const retained = h.registry.getDocument(h.id)!;
  expect(retained.summary).toMatchObject({ version: version + 1, dirty: true, closing: false, recoveryProtected: false });
  expect(retained.state.doc.toString()).toBe('old dirty');
  expect(retained.savedText).toBe(savedText);
  expect(retained.savedVersion).toBe(0);
  expect(retained.state.facet(EditorState.readOnly)).toBe(false);
  expect(undoDepth(retained.state)).toBe(historyDepth);
  expect(undo({ state: retained.state, dispatch: transaction => { h.registry.commit(h.id, [transaction]); } })).toBe(true);
  expect(h.registry.getDocument(h.id)?.state.doc.toString()).toBe('old');
  expect(h.release).not.toHaveBeenCalled();
});

it('keeps an uncertain native release read-only until another explicit close or Save As', async () => {
  const h = setup();
  const version = h.edit();
  h.release.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'Controlled lost Ack', retryable: true } });
  expect((await h.closing.close(h.id, version, 'discard')).ok).toBe(false);
  const retained = h.registry.getDocument(h.id)!;
  expect(retained.releaseUncertain).toBe(true);
  expect(retained.source).toBeNull();
  expect(retained.summary.readOnlyReason).toContain('关闭结果尚未确认');
  expect(retained.state.doc.toString()).toBe('old dirty');
  expect(retained.state.facet(EditorState.readOnly)).toBe(true);
  expect((await h.closing.close(h.id, retained.summary.version, 'discard')).ok).toBe(true);
  expect(h.registry.getDocument(h.id)).toBeUndefined();
});

it('can rebind a retained uncertain copy only after a successful explicit Save As', async () => {
  const h = setup();
  const version = h.edit();
  h.release.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'Controlled lost Ack', retryable: true } });
  await h.closing.close(h.id, version, 'discard');
  const captured = h.registry.captureSaveAs(h.id, 'save-as');
  if (!captured.ok) throw new Error('Retained full copy must support Save As');
  const metadata = { ...h.opened.metadata, displayPath: 'retained-copy.txt' };
  expect(h.registry.acknowledgeSaveAs(captured.value, { documentId: h.id, ref: h.opened.ref, metadata,
    ack: { documentVersion: captured.value.request.documentVersion, diskRevision: metadata.diskRevision,
      savedAt: metadata.modifiedAt, sizeBytes: metadata.sizeBytes } }).ok).toBe(true);
  expect(h.registry.getDocument(h.id)?.releaseUncertain).toBe(false);
  expect(h.registry.getDocument(h.id)?.summary).toMatchObject({ dirty: false, readOnlyReason: null, title: 'retained-copy.txt' });
});

it('routes an untitled close through Save As and keeps it on destination cancellation', async () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: '未命名正文😀' } })]);
  const destination = vi.fn(async () => ({ ok: false as const, error: { code: 'CANCELLED' as const, message: 'Path selection cancelled', retryable: false } }));
  const saving = new SaveCoordinator(registry, undefined, undefined, destination);
  const discard = vi.fn();
  const release = vi.fn();
  const closing = new CloseCoordinator(registry, saving, discard, release);
  expect(await closing.close(id, 1, 'save')).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(destination).toHaveBeenCalledTimes(1);
  expect(registry.getDocument(id)?.state.doc.toString()).toBe('未命名正文😀');
  expect(registry.getDocument(id)?.summary.dirty).toBe(true);
  expect(discard).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});

it('rejects a stale close version, selects the right neighbor, and releases metrics at the last tab', async () => {
  const h = setup();
  const second = h.registry.createUntitled();
  const third = h.registry.createUntitled();
  h.registry.activate(second);
  expect(await h.closing.close(h.id, 1, 'clean')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(h.release).not.toHaveBeenCalled();
  expect((await h.closing.close(second, 0, 'clean')).ok).toBe(true);
  expect(h.registry.getSnapshot().activeId).toBe(third);
  expect((await h.closing.close(third, 0, 'clean')).ok).toBe(true);
  expect(h.registry.getSnapshot().activeId).toBe(h.id);
  expect((await h.closing.close(h.id, 0, 'clean')).ok).toBe(true);
  expect(h.registry.getSnapshot()).toEqual({ activeId: null, documents: [] });
  expect(h.registry.getMetrics(h.id)).toBeNull();
  expect(h.discard).not.toHaveBeenCalled();
});

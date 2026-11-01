import { expect, it } from 'vitest';
import { isolateHistory, undo } from '@codemirror/commands';
import { isOpenDocument } from '../../bridge/files';
import { DocumentRegistry } from './documents';
import type { DiskRevision, SaveAck } from '../../shared/contracts/files';

function fixture(options: { id?: string; readOnly?: boolean; encoding?: string; lineEnding?: string } = {}) {
  const value: unknown = {
    documentId: options.id ?? 'native-document', ref: { grantId: 'fixture-grant', relativePath: '' },
    metadata: { displayPath: 'E:\\fixtures\\中文 fixture.txt', sizeBytes: 7, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: options.readOnly ?? false, diskRevision: 'revision-1' },
    format: { encoding: options.encoding ?? 'utf-8', bom: 'none', lineEnding: options.lineEnding ?? 'lf' },
    warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'private\nbody', newlineMap: { documentVersion: 0, endings: ['lf'] } },
  };
  if (!isOpenDocument(value)) throw new Error('Invalid test fixture');
  return value;
}

it('creates independent untitled documents with no path and UTF8/CRLF defaults', () => {
  const registry = new DocumentRegistry();
  const first = registry.createUntitled();
  const second = registry.createUntitled();
  expect(first).not.toBe(second);
  expect(registry.getSnapshot().documents.map(document => document.title)).toEqual(['无标题 1', '无标题 2']);
  expect(registry.getDocument(first)?.source).toBeNull();
  expect(registry.getDocument(first)?.summary).toMatchObject({ displayPath: null, dirty: false, format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' } });
});

it('reopens aliases without losing unsaved input, selection, history or version', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const before = registry.getDocument(id)!;
  expect(registry.commit(id, [before.state.update({ changes: { from: 0, insert: '编辑' }, selection: { anchor: 2 } })]).ok).toBe(true);
  const edited = registry.getDocument(id)!.state;
  registry.createUntitled();
  registry.openDocument({ ...fixture(), content: { kind: 'text', text: 'external content', newlineMap: { documentVersion: 0, endings: [] } } });
  expect(registry.getSnapshot().documents).toHaveLength(2);
  expect(registry.getDocument(id)!.state).toBe(edited);
  expect(edited.selection.main.head).toBe(2);
  expect(registry.getDocument(id)!.summary).toMatchObject({ dirty: true, version: 1 });
  expect(undo({ state: edited, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.summary).toMatchObject({ dirty: false, version: 2 });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody');
});

it('does not merge different physical identities by display path', () => {
  const registry = new DocumentRegistry();
  registry.openDocument(fixture());
  registry.openDocument(fixture({ id: 'different-physical-file' }));
  expect(registry.getSnapshot().documents).toHaveLength(2);
});

it('rejects read-only edits even when a caller bypasses CM input handling', () => {
  for (const options of [{ readOnly: true }, { encoding: 'utf-16le' }, { lineEnding: 'mixed' }]) {
    const registry = new DocumentRegistry();
    const id = registry.openDocument(fixture(options));
    const initial = registry.getDocument(id)!.state;
    const result = registry.commit(id, [initial.update({ changes: { from: 0, insert: 'x' } })]);
    expect(result).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    expect(registry.getDocument(id)!.state).toBe(initial);
  }
});

it('rejects an entire stale batch without committing its earlier valid transaction', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const initial = registry.getDocument(id)!.state;
  const first = initial.update({ changes: { from: 0, insert: 'one' } });
  const stale = initial.update({ changes: { from: 0, insert: 'two' } });
  expect(registry.commit(id, [first, stale])).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(registry.getDocument(id)!.state).toBe(initial);
});

it('keeps selections outside React snapshots and never publishes the body text', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const snapshot = registry.getSnapshot();
  let emissions = 0;
  const unsubscribe = registry.subscribe(() => { emissions++; });
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ selection: { anchor: 4 } })]);
  expect(registry.getSnapshot()).toBe(snapshot);
  expect(emissions).toBe(0);
  expect(JSON.stringify(snapshot)).not.toContain('private');
  unsubscribe();
});

function acknowledgement(version: number, revision = 'revision-saved'): SaveAck {
  return { documentVersion: version, diskRevision: revision as DiskRevision, sizeBytes: 24, savedAt: '2026-11-01T06:00:00Z' };
}

it('freezes a save snapshot and keeps input typed during the save dirty', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: ' saved' }, annotations: isolateHistory.of('full') })]);
  const capture = registry.captureSave(id);
  if (!capture.ok) throw new Error('Expected writable fixture');
  expect(Object.isFrozen(capture.value.request)).toBe(true);
  expect(Object.isFrozen(capture.value.request.format)).toBe(true);
  expect(Object.isFrozen(capture.value.request.newlineMap?.endings)).toBe(true);
  expect(capture.value.request).toMatchObject({ documentVersion: 1, expectedDiskRevision: 'revision-1', text: 'private\nbody saved', newlineMap: { documentVersion: 1, endings: ['lf'] } });
  state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: ' newer' }, annotations: isolateHistory.of('full') })]);
  const edited = registry.getDocument(id)!.state;
  expect(registry.acknowledgeSave(capture.value, acknowledgement(1))).toEqual({ ok: true, value: { dirty: true } });
  expect(registry.getDocument(id)!.state).toBe(edited);
  const next = registry.captureSave(id);
  expect(next).toMatchObject({ ok: true, value: { request: { expectedDiskRevision: 'revision-saved', text: 'private\nbody saved newer', documentVersion: 2 } } });
  expect(capture.value.request.text).toBe('private\nbody saved');
  // Saving does not reset history; undoing just the newer input reaches the saved baseline.
  expect(undo({ state: edited, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody saved');
  expect(registry.getDocument(id)!.summary.dirty).toBe(false);
});

it('clears dirty on a matching save without changing text, selection or undo state', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture({ lineEnding: 'crlf' }));
  const before = registry.getDocument(id)!.state;
  registry.commit(id, [before.update({ changes: { from: before.doc.length, insert: '\nnew' }, selection: { anchor: 2 } })]);
  const captured = registry.captureSave(id);
  if (!captured.ok) throw new Error('Expected writable fixture');
  expect(captured.value.request.newlineMap?.endings).toEqual(['crlf', 'crlf']);
  const edited = registry.getDocument(id)!.state;
  expect(registry.acknowledgeSave(captured.value, acknowledgement(1))).toEqual({ ok: true, value: { dirty: false } });
  expect(registry.getDocument(id)!.state).toBe(edited);
  expect(edited.selection.main.head).toBe(2);
  expect(undo({ state: edited, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody');
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
});

it('rejects mismatched and replayed save acknowledgements without changing the baseline', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'changed ' } })]);
  const captured = registry.captureSave(id);
  if (!captured.ok) throw new Error('Expected writable fixture');
  expect(registry.acknowledgeSave(captured.value, acknowledgement(2))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe('revision-1');
  expect(registry.acknowledgeSave(captured.value, acknowledgement(1)).ok).toBe(true);
  expect(registry.acknowledgeSave(captured.value, acknowledgement(1, 'old-replay'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe('revision-saved');
});

it('refuses to fabricate a save destination for untitled and read-only documents', () => {
  const registry = new DocumentRegistry();
  expect(registry.captureSave(registry.createUntitled())).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
  for (const options of [{ id: 'readonly', readOnly: true }, { id: 'mixed', lineEnding: 'mixed' }, { id: 'utf16', encoding: 'utf-16le' }]) {
    expect(registry.captureSave(registry.openDocument(fixture(options)))).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  }
});

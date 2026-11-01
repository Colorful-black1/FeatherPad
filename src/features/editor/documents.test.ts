import { expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import { isOpenDocument } from '../../bridge/files';
import { DocumentRegistry } from './documents';

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

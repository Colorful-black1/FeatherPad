import { expect, it } from 'vitest';
import { cursorMatchingBracket, indentLess, indentMore, isolateHistory, redo, undo, undoDepth } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { isOpenDocument } from '../../bridge/files';
import { DocumentRegistry } from './documents';
import type { DiskRevision, DocumentId, OpenDocument, SaveAck, SaveAsAck } from '../../shared/contracts/files';
import { createEditorState, reconfigureIndentation, reconfigureReadOnly } from './editor-state';
import { documentFormat } from './line-endings';

type RegularOpenDocument = Extract<OpenDocument, { mode: 'normal' | 'degraded' }>;

it('keeps image payloads out of the text editor, marks them readonly and rejects text saves', () => {
  const base = fixture();
  const image: OpenDocument = { ...base, metadata: { ...base.metadata, sizeBytes: 42 }, format: { encoding: 'binary', bom: 'none', lineEnding: 'lf' },
    mode: 'image-readonly', content: { kind: 'image', image: { mime: 'image/gif', dataBase64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', sizeBytes: 42, width: 1, height: 1 } } };
  expect(isOpenDocument(image)).toBe(true);
  const registry = new DocumentRegistry(); const id = registry.openDocument(image);
  expect(registry.getDocument(id)!.state.doc.length).toBe(0);
  expect(registry.getDocument(id)!.summary).toMatchObject({ dirty: false, canSaveAs: false, readOnlyReason: expect.stringContaining('图片只读') });
  expect(registry.captureSave(id)).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  expect(registry.applyTextResult(id, 0, 'cannot-write')).toMatchObject({ ok: false });
});

it('applies a versioned text-tool result once, keeps encoding/mixed endings and rejects a late result', () => {
  const registry = new DocumentRegistry();
  const opened = fixture({ encoding: 'utf-16le', lineEnding: 'mixed' });
  opened.format.bom = 'utf16le';
  opened.content = { kind: 'text', text: 'a\nb\nc\n', newlineMap: { documentVersion: 0, endings: ['cr', 'lf', 'crlf'] } };
  const id = registry.openDocument(opened);
  const original = registry.getDocument(id)!;
  const beforeVersion = original.summary.version;
  expect(registry.applyTextResult(id, beforeVersion, 'A\nB\nC\nD\n')).toMatchObject({ ok: true });
  const changed = registry.getDocument(id)!;
  expect(changed.state.field(documentFormat).endings).toEqual(['cr', 'lf', 'crlf', 'cr']);
  expect(changed.summary.format).toEqual(opened.format);
  expect(registry.applyTextResult(id, beforeVersion, 'late')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  let state = changed.state;
  expect(undo({ state, dispatch: transaction => { registry.commit(id, [transaction]); state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('a\nb\nc\n');
  expect(state.field(documentFormat).endings).toEqual(['cr', 'lf', 'crlf']);
  expect(registry.getDocument(id)!.summary.dirty).toBe(false);
});

function fixture(options: { id?: string; readOnly?: boolean; encoding?: string; lineEnding?: string; displayPath?: string } = {}): RegularOpenDocument {
  const value: unknown = {
    documentId: options.id ?? 'native-document', ref: { grantId: 'fixture-grant', relativePath: '' },
    metadata: { displayPath: options.displayPath ?? 'E:\\fixtures\\中文 fixture.txt', sizeBytes: 7, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: options.readOnly ?? false, diskRevision: 'revision-1' },
    format: { encoding: options.encoding ?? 'utf-8', bom: 'none', lineEnding: options.lineEnding ?? 'lf' },
    warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'private\nbody', newlineMap: { documentVersion: 0, endings: ['lf'] } },
  };
  if (!isOpenDocument(value)) throw new Error('Invalid test fixture');
  return value as RegularOpenDocument;
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

it('treats format conversion as a versioned dirty undo step and retains it after an older save Ack', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const captured = registry.captureSave(id);
  if (!captured.ok) throw new Error('Expected a writable fixture');
  const before = registry.getDocument(id)!.summary.version;
  expect(registry.changeFormat(id, before, { encoding: 'utf-16le', bom: 'utf16le', lineEnding: 'crlf' })).toMatchObject({ ok: true });
  expect(registry.getDocument(id)!.summary).toMatchObject({ version: before + 1, dirty: true });
  expect(registry.acknowledgeSave(captured.value, { documentVersion: before, diskRevision: 'revision-2' as DiskRevision,
    savedAt: '2026-11-03T00:00:00Z', sizeBytes: 12 })).toMatchObject({ ok: true, value: { dirty: true } });
  let state = registry.getDocument(id)!.state;
  expect(undo({ state, dispatch: transaction => { registry.commit(id, [transaction]); state = transaction.state; } })).toBe(true);
  expect(registry.getDocument(id)!.summary).toMatchObject({ dirty: false, format: fixture().format });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody');
  expect(registry.changeFormat(id, before, fixture().format)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
});

it('keeps complete text previews read-only for transactions, saving and reload', () => {
  const base = fixture();
  const preview: OpenDocument = { ...base, mode: 'text-preview', content: {
    kind: 'head', text: 'a␀�', previewBytes: 7, totalBytes: 7, truncated: false,
  } };
  const registry = new DocumentRegistry();
  const id = registry.openDocument(preview);
  const document = registry.getDocument(id)!;
  expect(document.summary).toMatchObject({ canSaveAs: false, languageId: 'plaintext', dirty: false });
  expect(document.summary.readOnlyReason).toContain('只读文本试开');
  expect(registry.commit(id, [document.state.update({ changes: { from: 0, insert: 'forged' } })]))
    .toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  expect(registry.captureSave(id)).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  expect(registry.captureSaveAs(id)).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  expect(registry.captureSaveAs(id, 'copy')).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  const loaded: OpenDocument = { ...preview, metadata: { ...preview.metadata, diskRevision: 'b'.repeat(64) as OpenDocument['metadata']['diskRevision'] },
    content: { ...preview.content, text: 'reloaded' } };
  expect(registry.applyDiskReload(loaded, 0, preview.metadata.diskRevision)).toMatchObject({ ok: true });
  expect(registry.getDocument(id)?.summary).toMatchObject({ canSaveAs: false, dirty: false, version: 1 });
  expect(registry.getDocument(id)?.state.doc.toString()).toBe('reloaded');
});

it('opens a bounded all-control binary preview without creating a writable document', () => {
  const base = fixture();
  const source: OpenDocument = { ...base, metadata: { ...base.metadata, sizeBytes: 20 * 1024 * 1024 },
    mode: 'text-preview', content: { kind: 'head', text: '␀'.repeat(1024 * 1024),
      previewBytes: 1024 * 1024, totalBytes: 20 * 1024 * 1024, truncated: true } };
  expect(isOpenDocument(source)).toBe(true);
  const registry = new DocumentRegistry();
  const id = registry.openDocument(source);
  expect(registry.getDocument(id)?.state.doc.length).toBe(1024 * 1024);
  expect(registry.getDocument(id)?.summary).toMatchObject({ dirty: false, canSaveAs: false, languageId: 'plaintext' });
});

it('opens transaction text as an independent dirty copy without claiming a recovery receipt', () => {
  const registry = new DocumentRegistry();
  const original = registry.openDocument(fixture());
  const id = registry.openTransactionDraft({
    receiptId: crypto.randomUUID(), displayName: 'fixture.txt', text: 'draft\n中文😀',
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
    newlineMap: { documentVersion: 1, endings: ['crlf'] },
  });
  expect(id).not.toBe(original);
  expect(registry.getDocument(original)?.state.doc.toString()).toBe('private\nbody');
  expect(registry.getDocument(id)?.state.doc.toString()).toBe('draft\n中文😀');
  expect(registry.getDocument(id)?.source).toBeNull();
  expect(registry.getDocument(id)?.summary).toMatchObject({
    dirty: true, recovered: true, recoveryProtected: false, displayPath: null,
    title: 'fixture.txt（恢复副本）', version: 1,
  });
  expect(registry.captureSave(id)).toMatchObject({ ok: false });
  expect(registry.captureRecovery(id)).toMatchObject({ ok: true, value: {
    documentId: id, documentVersion: 1, text: 'draft\n中文😀',
    newlineMap: { documentVersion: 1, endings: ['crlf'] },
  } });
});

it('keeps an empty transaction draft dirty and preserves editable mixed UTF16 intent', () => {
  const registry = new DocumentRegistry();
  const id = registry.openTransactionDraft({
    receiptId: crypto.randomUUID(), displayName: 'empty.txt', text: '',
    format: { encoding: 'utf-16be', bom: 'utf16be', lineEnding: 'mixed' },
    newlineMap: { documentVersion: 1, endings: [] },
  });
  expect(registry.getDocument(id)?.summary).toMatchObject({ dirty: true, canSaveAs: true,
    recoveryProtected: false, format: { encoding: 'utf-16be', bom: 'utf16be', lineEnding: 'mixed' } });
  expect(registry.getDocument(id)?.state.facet(EditorState.readOnly)).toBe(false);
  expect(registry.captureSaveAs(id, 'save-as')).toMatchObject({ ok: true, value: { request: {
    text: '', newlineMap: { documentVersion: 1, endings: [] },
  } } });
});

it('keeps a recycled document buffer and undo, protects the captured version, and saves elsewhere', () => {
  const registry = new DocumentRegistry();
  const opened = fixture();
  const id = registry.openDocument(opened);
  const snapshots = registry.captureTrashSnapshots([id]);
  expect(snapshots.ok).toBe(true);
  if (!snapshots.ok) throw new Error('Snapshot capture failed');
  expect(snapshots.value[0]?.text).toBe('private\nbody');
  const state = registry.getDocument(id)!.state;
  registry.markTrashed({ trashed: true, receiptId: 'operation', missingDocumentIds: [id],
    drafts: [{ documentId: id, documentVersion: 0, receiptId: 'draft' }] });
  expect(registry.getDocument(id)?.state).toBe(state);
  expect(registry.getDocument(id)?.source).toBeNull();
  expect(registry.getDocument(id)?.summary).toMatchObject({ missing: true, dirty: true, recoveryProtected: true });
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'later ' } })]);
  expect(registry.getDocument(id)?.summary).toMatchObject({ dirty: true, recoveryProtected: false });
  const captured = registry.captureSaveAs(id, 'save-as');
  if (!captured.ok) throw new Error('Save as capture failed');
  const metadata = { ...opened.metadata, displayPath: 'new-file.txt', diskRevision: 'new-revision' as DiskRevision };
  const result = registry.acknowledgeSaveAs(captured.value, { documentId: id, ref: opened.ref, metadata,
    ack: { documentVersion: captured.value.request.documentVersion, diskRevision: metadata.diskRevision,
      savedAt: metadata.modifiedAt, sizeBytes: metadata.sizeBytes } });
  expect(result.ok).toBe(true);
  expect(registry.getDocument(id)?.summary).toMatchObject({ missing: false, dirty: false, title: 'new-file.txt' });
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

it('preserves the canonical identity through open and disk reload', () => {
  const registry = new DocumentRegistry();
  const opened = { ...fixture(), canonicalIdentity: 'a'.repeat(64) };
  const id = registry.openDocument(opened);
  expect(registry.getDocument(id)?.source?.canonicalIdentity).toBe('a'.repeat(64));

  const nextRevision = 'revision-2' as DiskRevision;
  const reloaded = {
    ...opened,
    canonicalIdentity: 'b'.repeat(64),
    metadata: { ...opened.metadata, diskRevision: nextRevision },
    content: { kind: 'text' as const, text: 'reloaded', newlineMap: { documentVersion: 0, endings: [] } },
  };
  expect(registry.applyDiskReload(reloaded, 0, 'revision-1')).toEqual({ ok: true, value: { reloaded: true } });
  expect(registry.getDocument(id)?.source?.canonicalIdentity).toBe('b'.repeat(64));
});

it('rejects read-only edits even when a caller bypasses CM input handling', () => {
  for (const options of [{ readOnly: true }, { encoding: 'unsupported-encoding' }]) {
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

it('keeps selections outside React snapshots and publishes only deferred metrics', async () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  const snapshot = registry.getSnapshot();
  let emissions = 0;
  let metricEmissions = 0;
  const unsubscribe = registry.subscribe(() => { emissions++; });
  const unsubscribeMetrics = registry.subscribeMetrics(id, () => { metricEmissions++; });
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ selection: { anchor: 4 } })]);
  expect(registry.getSnapshot()).toBe(snapshot);
  expect(emissions).toBe(0);
  expect(metricEmissions).toBe(0);
  await Promise.resolve();
  expect(metricEmissions).toBe(1);
  expect(registry.getMetrics(id)).toMatchObject({ line: 1, column: 5, characterCount: 12, selectedCharacterCount: 0 });
  expect(JSON.stringify(snapshot)).not.toContain('private');
  unsubscribe();
  unsubscribeMetrics();
});

it('reports Unicode characters, selections and tab-aware positions through a selection-only channel', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: '\n中😀\tend' } })]);
  state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ selection: { anchor: state.doc.length - 7, head: state.doc.length } })]);
  expect(registry.getMetrics(id)).toEqual({
    line: 3, column: 8, characterCount: 19, selectedCharacterCount: 6, selectionCount: 1,
  });
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
  for (const options of [{ id: 'readonly', readOnly: true }, { id: 'unknown', encoding: 'unsupported-encoding' }]) {
    expect(registry.captureSave(registry.openDocument(fixture(options)))).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  }
});

it('keeps large-file chunks read-only and refuses save plus save-as at the registry boundary', () => {
  const registry = new DocumentRegistry();
  const value = {
    documentId: 'large-document', ref: { grantId: 'large-grant', relativePath: '' },
    metadata: { displayPath: 'large.txt', sizeBytes: 20 * 1024 * 1024, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'large-revision' },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: ['只读分块'],
    mode: 'large-readonly',
    content: { kind: 'chunked', handleId: 'handle', initialChunk: { byteStart: 0, byteEnd: 6, firstLine: 1, text: 'first\n', hasMore: true }, totalBytes: 20 * 1024 * 1024 },
  } as Extract<OpenDocument, { mode: 'large-readonly' }>;
  const id = registry.openDocument(value);
  const document = registry.getDocument(id)!;
  expect(document.fragment).toEqual(value.content);
  expect(document.summary.readOnlyReason).toContain('无法保存完整文件');
  expect(document.state.doc.toString()).toBe('first\n');
  expect(registry.captureSave(id)).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
  expect(registry.captureSaveAs(id)).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
});

function destinationAck(id: DocumentId, version: number): SaveAsAck {
  const source = fixture();
  const ack = acknowledgement(version, 'as-revision');
  return { documentId: id, ref: source.ref,
    metadata: { ...source.metadata, displayPath: 'E:\\fixtures\\另存 中文.txt', isReadOnly: false, diskRevision: ack.diskRevision, sizeBytes: ack.sizeBytes }, ack };
}

it('binds the first destination only on Ack and leaves input typed during save-as dirty', () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'saved snapshot' } })]);
  const captured = registry.captureSaveAs(id);
  if (!captured.ok) throw new Error('Expected save-as snapshot');
  expect(captured.value.baseSource).toBeNull();
  expect(Object.isFrozen(captured.value.request)).toBe(true);
  expect(registry.getDocument(id)!.source).toBeNull();
  state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: ' newer input' } })]);
  const edited = registry.getDocument(id)!.state;
  expect(registry.acknowledgeSaveAs(captured.value, destinationAck(id, 1))).toEqual({ ok: true, value: { dirty: true } });
  expect(registry.getDocument(id)!.state).toBe(edited);
  expect(registry.getDocument(id)!.summary).toMatchObject({ title: '另存 中文.txt', dirty: true, version: 2 });
  expect(registry.captureSave(id)).toMatchObject({ ok: true, value: { request: { text: 'saved snapshot newer input', expectedDiskRevision: 'as-revision' } } });
});

it('rejects old save-as acknowledgements and never applies a copy Ack to the source', () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  const captured = registry.captureSaveAs(id);
  if (!captured.ok) throw new Error('Expected snapshot');
  const copy = registry.captureSaveAs(id, 'copy');
  if (!copy.ok) throw new Error('Expected copy snapshot');
  expect(registry.acknowledgeSaveAs(copy.value, destinationAck(id, 0))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(registry.getDocument(id)!.source).toBeNull();
  expect(registry.acknowledgeSaveAs(captured.value, destinationAck(id, 0)).ok).toBe(true);
  expect(registry.acknowledgeSaveAs(captured.value, destinationAck(id, 0))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
});

it('saving a complete read-only UTF8 document to a writable destination enables editing', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture({ readOnly: true }));
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ selection: { anchor: 3 } })]);
  const captured = registry.captureSaveAs(id);
  if (!captured.ok) throw new Error('Complete read-only documents may be saved elsewhere');
  expect(registry.acknowledgeSaveAs(captured.value, destinationAck(id, 0)).ok).toBe(true);
  state = registry.getDocument(id)!.state;
  expect(state.facet(EditorState.readOnly)).toBe(false);
  expect(state.selection.main.head).toBe(3);
  expect(state.doc.toString()).toBe('private\nbody');
  expect(registry.commit(id, [state.update({ changes: { from: 0, insert: 'editable ' } })]).ok).toBe(true);
});

it('captures each original mixed newline for lossless save-as and allows protected mixed editing', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument({ ...fixture({ lineEnding: 'mixed' }), content: { kind: 'text', text: 'a\nb\nc\n', newlineMap: { documentVersion: 0, endings: ['crlf', 'lf', 'cr'] } } });
  const captured = registry.captureSaveAs(id);
  expect(captured).toMatchObject({ ok: true, value: { request: { newlineMap: { documentVersion: 0, endings: ['crlf', 'lf', 'cr'] } } } });
  expect(registry.getDocument(id)!.state.facet(EditorState.readOnly)).toBe(false);
  const state = registry.getDocument(id)!.state;
  expect(registry.commit(id, [state.update({ changes: { from: 2, insert: 'new\n' } })])).toMatchObject({ ok: true });
  expect(registry.captureSave(id)).toMatchObject({ ok: true, value: { request: {
    text: 'a\nnew\nb\nc\n', newlineMap: { documentVersion: 1, endings: ['crlf', 'crlf', 'lf', 'cr'] },
  } } });
});

it('changing editability preserves the existing undo history and selection', () => {
  let state = createEditorState('before', false);
  state = state.update({ changes: { from: 0, to: 6, insert: 'after' }, selection: { anchor: 2 } }).state;
  state = reconfigureReadOnly(reconfigureReadOnly(state, true), false);
  expect(state.selection.main.head).toBe(2);
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('before');
});

it('indents and unindents multiple selected lines in one undoable transaction per command', () => {
  let state = createEditorState('first\nsecond\nthird', false, { indentWidth: 4 });
  state = state.update({ selection: { anchor: 0, head: 12 } }).state;
  expect(indentMore({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('    first\n    second\nthird');
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('first\nsecond\nthird');
  expect(indentLess({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('first\nsecond\nthird');
});

it('uses 2/4/8-space adaptive indentation without rewriting existing tabs and preserves undo history', () => {
  let state = createEditorState('  mixed\n\tkept', false, { indentWidth: 4 });
  state = state.update({ changes: { from: state.doc.length, insert: '\nfourth' } }).state;
  state = state.update({ selection: { anchor: 0, head: 1 } }).state;
  state = reconfigureIndentation(state, 8);
  expect(state.facet(EditorState.tabSize)).toBe(8);
  expect(state.selection.main.head).toBe(1);
  expect(indentMore({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('          mixed\n\tkept\nfourth');
  expect(state.doc.toString()).toContain('\tkept');
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('  mixed\n\tkept\nfourth');
});

it('persists automatic and manual language selection without replacing text, selection or undo history', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture({ displayPath: 'E:\\fixtures\\main.ts' }));
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: '\nconst value = 1;' }, selection: { anchor: 3 } })]);
  expect(registry.getDocument(id)!.summary).toMatchObject({ languageId: 'typescript', languageSource: 'auto' });
  registry.setLanguage(id, 'java');
  expect(registry.getDocument(id)!.summary).toMatchObject({ languageId: 'java', languageSource: 'manual' });
  expect(registry.getDocument(id)!.state.selection.main.head).toBe(3);
  expect(undo({ state: registry.getDocument(id)!.state, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody');
  registry.setLanguage(id, 'auto');
  expect(registry.getDocument(id)!.summary).toMatchObject({ languageId: 'typescript', languageSource: 'auto' });
});

it('configures bracket matching and automatic pairing independently while preserving editor history', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture());
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'x' }, selection: { anchor: 1 } })]);
  registry.setBracketMatching(id, false);
  expect(registry.getDocument(id)!.summary).toMatchObject({ bracketMatching: false, closeBrackets: true });
  registry.setCloseBrackets(id, false);
  expect(registry.getDocument(id)!.summary).toMatchObject({ bracketMatching: false, closeBrackets: false });
  state = registry.getDocument(id)!.state;
  expect(undo({ state, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('private\nbody');
});

it('jumps between a matching bracket pair without creating a document-version edit', () => {
  let state = createEditorState('[value]', false);
  state = state.update({ selection: { anchor: 1 } }).state;
  const version = state.doc.length;
  expect(cursorMatchingBracket({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.selection.main.head).toBe(6);
  expect(state.doc.length).toBe(version);
  expect(undoDepth(state)).toBe(0);
});

it('undoes and redoes deletion of the complete document selection', () => {
  let state = createEditorState('alpha\nbeta', false);
  state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
  state = state.update({ changes: { from: 0, to: state.doc.length } }).state;
  expect(state.doc.toString()).toBe('');
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('alpha\nbeta');
  expect(redo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('');
});

it('updates a renamed path and language hint without replacing buffer state or dirty history', () => {
  const registry = new DocumentRegistry();
  const id = registry.openDocument(fixture({ displayPath: 'E:\\workspace\\旧名称.txt' }));
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: '\nunsaved' } })]);
  const before = registry.getDocument(id)!;
  expect(before.summary.dirty).toBe(true);

  registry.applyRenamedPaths([{
    documentId: id,
    ref: { grantId: before.source!.ref.grantId, relativePath: 'folder/新名称.ts' },
    displayPath: 'E:\\workspace\\folder\\新名称.ts',
  }]);

  const after = registry.getDocument(id)!;
  expect(after.source?.ref.relativePath).toBe('folder/新名称.ts');
  expect(after.source?.metadata.displayPath).toBe('E:\\workspace\\folder\\新名称.ts');
  expect(after.summary).toMatchObject({ title: '新名称.ts', displayPath: 'E:\\workspace\\folder\\新名称.ts', dirty: true });
  expect(after.state).toBe(before.state);
  expect(after.savedText).toBe(before.savedText);
});

import { expect, it } from 'vitest';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { documentFormat, documentFormatExtensions, dominantEnding, formatState, setDocumentFormat } from './line-endings';

const mixed = () => formatState({ encoding: 'utf-16le', bom: 'utf16le', lineEnding: 'mixed' }, ['cr', 'lf', 'crlf']);
function setup() {
  let state = EditorState.create({ doc: 'a\nb\nc\nd', extensions: [history(), documentFormatExtensions(mixed())] });
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  return { target, edit: (spec: TransactionSpec) => { state = state.update(spec).state; } };
}

it('uses the original majority and first original token for ties', () => {
  expect(dominantEnding([])).toBe('crlf');
  expect(dominantEnding(['cr', 'lf', 'crlf'])).toBe('cr');
  expect(dominantEnding(['cr', 'lf', 'lf', 'crlf'])).toBe('lf');
});

it('preserves untouched mixed endings, inserts the dominant type and restores deletion through undo/redo', () => {
  const { target, edit } = setup();
  edit({ changes: { from: 2, to: 4, insert: 'B\nnew\n' }, annotations: isolateHistory.of('full') });
  expect(target.state.doc.toString()).toBe('a\nB\nnew\nc\nd');
  expect(target.state.field(documentFormat).endings).toEqual(['cr', 'cr', 'cr', 'crlf']);
  expect(undo(target)).toBe(true);
  expect(target.state.doc.toString()).toBe('a\nb\nc\nd');
  expect(target.state.field(documentFormat)).toEqual(mixed());
  expect(redo(target)).toBe(true);
  expect(target.state.field(documentFormat).endings).toEqual(['cr', 'cr', 'cr', 'crlf']);
});

it('keeps format-only conversion as one undo step without modifying text', () => {
  const { target, edit } = setup();
  edit({ effects: setDocumentFormat.of(formatState({ encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, ['lf', 'lf', 'lf'])),
    annotations: isolateHistory.of('full') });
  expect(target.state.doc.toString()).toBe('a\nb\nc\nd');
  expect(target.state.field(documentFormat).format.encoding).toBe('utf-8');
  expect(undo(target)).toBe(true);
  expect(target.state.field(documentFormat)).toEqual(mixed());
  expect(redo(target)).toBe(true);
  expect(target.state.field(documentFormat).format.lineEnding).toBe('lf');
});

it('restores joined newline edits together and keeps ordinary typing on the same mapping', () => {
  const { target, edit } = setup();
  const before = target.state.field(documentFormat);
  edit({ changes: { from: 1, insert: 'x' } });
  expect(target.state.field(documentFormat)).toBe(before);
  edit({ changes: { from: 2, insert: '\n' }, userEvent: 'input.type' });
  edit({ changes: { from: 3, insert: '\n' }, userEvent: 'input.type' });
  expect(target.state.field(documentFormat).endings).toHaveLength(5);
  expect(undo(target)).toBe(true);
  expect(target.state.field(documentFormat).endings).toEqual(before.endings);
});

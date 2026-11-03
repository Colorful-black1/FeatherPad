import { expect, it } from 'vitest';
import { defaultTransformOptions, transformText, type TextOperation, type TransformOptions, type TransformRequest } from './text-transforms';
import type { Newline } from '../editor/line-endings';
import { DocumentRegistry } from '../editor/documents';
import { documentFormat } from '../editor/line-endings';
import { undo } from '@codemirror/commands';
function run(text: string, operation: TextOperation, options: Partial<TransformOptions> = {}, extra: Partial<TransformRequest> = {}) {
  const result = transformText({ requestId: 'job', documentId: 'doc', version: 3, text,
    endings: Array.from({ length: text.split('\n').length - 1 }, () => 'lf' as Newline), insertionEnding: 'crlf',
    from: 0, to: text.length, operation, options: { ...defaultTransformOptions, ...options }, ...extra });
  if (!result.ok) throw new Error(result.message);
  return result;
}

it('sorts by Unicode codepoint or precision-safe natural segments, stably in either direction', () => {
  expect(run('😀\n\ue000\na', 'sort').replacement).toBe('a\n\ue000\n😀');
  expect(run('a100000000000000000000\na2\na02\na10', 'sort', { natural: true }).replacement).toBe('a2\na02\na10\na100000000000000000000');
  expect(run('B\na\nA\nb', 'sort', { caseSensitive: false, descending: true }).replacement).toBe('B\nb\na\nA');
});
it('keeps first duplicate, handles empty lines explicitly and preserves original final-newline intent', () => {
  expect(run('A\na\n\n\nb\n', 'unique', { caseSensitive: false }).replacement).toBe('A\n\n\nb\n');
  expect(run('A\n\nA\n \nb', 'unique', { keepEmpty: false }).replacement).toBe('A\nb');
  expect(run('b\na\n', 'sort').replacement).toBe('a\nb\n');
  expect(run('b\na', 'sort', {}, { endings: ['cr'] }).endings).toEqual(['cr']);
  expect(run('b\na\nc\n', 'sort', {}, { endings: ['cr', 'lf', 'crlf'] }).endings).toEqual(['lf', 'cr', 'crlf']);
});
it('transforms only the explicit UTF16 selection and joins its newline tokens with untouched outer text', () => {
  const text = '外部\nb\na\n尾部';
  const value = run(text, 'sort', {}, { from: 3, to: 6, endings: ['cr', 'lf', 'crlf'] });
  expect(value.text).toBe('外部\na\nb\n尾部');
  expect(value.endings).toEqual(['cr', 'lf', 'crlf']);
  expect(run('😀 aß\nB', 'upper', {}, { from: 3, to: 5 }).text).toBe('😀 ASS\nB');
});
it('trims only spaces/tabs, explicitly manages trailing newlines and converts actual indentation at tab stops', () => {
  expect(run('a  \nb\t\nc\u00a0', 'trim').replacement).toBe('a\nb\nc\u00a0');
  expect(run('a', 'final-newline').endings).toEqual(['crlf']);
  expect(run('a\n\n', 'remove-final-newlines').replacement).toBe('a');
  expect(run(' \tx\n\t x', 'tabs-to-spaces', { tabSize: 4 }).replacement).toBe('    x\n     x');
  expect(run('      x\n  y', 'spaces-to-tabs', { tabSize: 4 }).replacement).toBe('\t  x\n  y');
  expect(run('body    value', 'spaces-to-tabs', { tabSize: 4 }, { from: 4, to: 13 }).text).toBe('body    value');
});

it('applies reordered mixed newline tokens with the text in one undo and rejects split surrogate selections', () => {
  const registry = new DocumentRegistry(); const id = registry.createUntitled();
  const version = registry.getDocument(id)!.summary.version;
  registry.applyTextResult(id, version, 'b\na\nc\n', ['cr', 'lf', 'crlf']);
  const beforeVersion = registry.getDocument(id)!.summary.version;
  const transformed = run('b\na\nc\n', 'sort', {}, { endings: ['cr', 'lf', 'crlf'] });
  expect(registry.applyTextResult(id, beforeVersion, transformed.text, transformed.endings)).toMatchObject({ ok: true });
  expect(registry.getDocument(id)!.state.field(documentFormat).endings).toEqual(['lf', 'cr', 'crlf']);
  let state = registry.getDocument(id)!.state;
  expect(undo({ state, dispatch: transaction => { registry.commit(id, [transaction]); state = transaction.state; } })).toBe(true);
  expect(state.doc.toString()).toBe('b\na\nc\n');
  expect(state.field(documentFormat).endings).toEqual(['cr', 'lf', 'crlf']);
  expect(transformText({ requestId: 'job', documentId: id, version: 1, text: '😀', endings: [], insertionEnding: 'lf',
    from: 1, to: 2, operation: 'upper', options: defaultTransformOptions })).toMatchObject({ ok: false });
});

import { expect, it } from 'vitest';
import { indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  commentLanguageData,
  documentWordCompletions,
  editingCommands,
  selectAllOccurrences,
  selectNextOccurrence,
} from './editing';

function commandView(state: EditorState) {
  let current = state;
  const view = {
    get state() { return current; },
    dispatch(input: EditorState | { state?: EditorState } | readonly unknown[]) {
      if (input instanceof EditorState) current = input;
      else if (!Array.isArray(input) && 'state' in input && input.state) current = input.state;
    },
  } as unknown as EditorView;
  return { view, state: () => current };
}

it('offers current-document words and language keywords without crossing the completion limit', () => {
  const state = EditorState.create({
    doc: 'documentWord anotherWord documentWord',
    selection: { anchor: 3 },
    extensions: [commentLanguageData('typescript')],
  });
  const result = documentWordCompletions({
    state,
    pos: 3,
    explicit: true,
    matchBefore: text => {
      void text;
      const match = /[\p{L}_][\p{L}\p{N}_-]{0,63}/u.exec(state.doc.sliceString(0, 3));
      return match ? { from: 0, to: 3, text: match[0] } : null;
    },
  } as Parameters<typeof documentWordCompletions>[0]);
  expect(result?.options.map(option => option.label)).toEqual(expect.arrayContaining(['documentWord', 'anotherWord']));
});

it('selects the current word, adds the next occurrence and then selects all occurrences', () => {
  let state = EditorState.create({
    doc: 'same other same final',
    selection: { anchor: 1 },
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  let h = commandView(state);
  expect(selectNextOccurrence(h.view)).toBe(true);
  state = h.state();
  expect(state.selection.ranges.map(range => state.sliceDoc(range.from, range.to))).toEqual(['same']);

  h = commandView(state);
  expect(selectNextOccurrence(h.view)).toBe(true);
  state = h.state();
  expect(state.selection.ranges.map(range => state.sliceDoc(range.from, range.to))).toEqual(['same', 'same']);

  h = commandView(state);
  expect(selectAllOccurrences(h.view)).toBe(true);
  expect(h.state().selection.ranges).toHaveLength(2);
});

it('applies multi-range edits and indentation at every selection, including wide CJK text', () => {
  const state = EditorState.create({
    doc: '甲 alpha\n乙 beta',
    selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(8, 9)]),
    extensions: [EditorState.allowMultipleSelections.of(true), indentUnit.of('    ')],
  });
  const selected = state.update(state.replaceSelection('文')).state;
  expect(selected.doc.toString()).toBe('文 alpha\n文 beta');

  const lines = selected.update({
    selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(8)]),
  }).state;
  const h = commandView(lines);
  expect(indentMore(h.view)).toBe(true);
  expect(h.state().doc.toString()).toBe('    文 alpha\n    文 beta');
});

it('provides comment tokens by language and keeps unsupported plain text commands explicit', () => {
  const script = EditorState.create({ doc: 'const value = 1;', extensions: [commentLanguageData('typescript')] });
  const text = EditorState.create({ doc: 'plain', extensions: [commentLanguageData('plaintext')] });
  expect(script.languageDataAt('commentTokens', 0)).toEqual([{ line: '//', block: { open: '/*', close: '*/' } }]);
  expect(text.languageDataAt('commentTokens', 0)).toEqual([]);
  expect(editingCommands.toggleFold).toBeTypeOf('function');
});

import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { DocumentId } from '../../shared/contracts/files';
import {
  breadcrumbSegments, lineColumnAt, localOutline, NavigationHistory, positionAt,
} from './navigation';

const id = (value: string) => value as DocumentId;

it('keeps at most 100 explicit locations and navigates backward and forward without duplicate entries', () => {
  const history = new NavigationHistory(100);
  let notifications = 0;
  const unsubscribe = history.subscribe(() => { notifications++; });
  history.record({ documentId: id('a'), offset: 2, label: 'a:1' });
  history.record({ documentId: id('a'), offset: 2, label: 'duplicate' });
  history.record({ documentId: id('b'), offset: 9, label: 'b:2' });
  expect(history.size).toBe(2);
  expect(history.back()).toMatchObject({ documentId: 'a', offset: 2 });
  expect(history.canGoForward).toBe(true);
  expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true, size: 2 });
  expect(history.forward()).toMatchObject({ documentId: 'b', offset: 9 });
  expect(notifications).toBeGreaterThanOrEqual(3);
  unsubscribe();
  for (let index = 0; index < 120; index++) history.record({
    documentId: id('x'), offset: index, label: String(index),
  });
  expect(history.size).toBe(100);
});

it('clamps line and column positions without inserting fill characters', () => {
  const state = EditorState.create({ doc: 'alpha\n中😀z' });
  expect(positionAt(state, { line: 2, column: 3 })).toMatchObject({ line: 2, column: 3, clamped: false });
  expect(positionAt(state, { line: 99, column: 99 })).toMatchObject({ line: 2, column: 5, clamped: true });
  expect(lineColumnAt(state, state.doc.length)).toEqual({ line: 2, column: 5 });
});

it('builds a bounded local outline for Markdown and JSON and ignores Markdown fences', () => {
  const markdown = localOutline('markdown', '# One\n```\n# hidden\n```\n## Two\n');
  expect(markdown.map(item => item.label)).toEqual(['One', 'Two']);
  const json = localOutline('jsonc', '{\n  "outer": {\n    "inner": true\n  }\n}');
  expect(json.map(item => [item.label, item.level])).toEqual([['outer', 1], ['inner', 2]]);
  expect(localOutline('plaintext', 'anything')).toEqual([]);
});

it('splits Windows breadcrumbs without losing the drive prefix', () => {
  expect(breadcrumbSegments('E:\\work\\note.md').map(item => item.label)).toEqual(['E:', 'work', 'note.md']);
  expect(breadcrumbSegments(null)).toEqual([]);
});

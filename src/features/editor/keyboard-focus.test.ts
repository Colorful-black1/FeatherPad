import { expect, it } from 'vitest';
import { undo, undoDepth } from '@codemirror/commands';
import { DocumentRegistry } from './documents';
import { createEditorState, reconfigureLanguage, reconfigureReadOnly } from './editor-state';
import { setTabFocusMode, tabFocusMode } from './keyboard-focus';

it('changing Tab focus keeps document bytes, selection, dirty version and undo unchanged', () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  const initial = registry.getDocument(id)!;
  registry.commit(id, [initial.state.update({ changes: { from: 0, insert: '中文\nbody' }, selection: { anchor: 2 } })]);
  const before = registry.getDocument(id)!;
  const version = before.summary.version;
  const depth = undoDepth(before.state);
  registry.commit(id, [before.state.update({ effects: setTabFocusMode.of(true) })]);
  const after = registry.getDocument(id)!;
  expect(after.state.field(tabFocusMode)).toBe(true);
  expect(after.state.doc.toString()).toBe('中文\nbody');
  expect(after.state.selection.main.anchor).toBe(2);
  expect(after.summary).toMatchObject({ version, dirty: true });
  expect(undoDepth(after.state)).toBe(depth);
  expect(undo({ state: after.state, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('');
});

it('Tab focus survives language/read-only reconfiguration without affecting another document', () => {
  const registry = new DocumentRegistry();
  const first = registry.createUntitled();
  const second = registry.createUntitled();
  const state = registry.getDocument(first)!.state;
  registry.commit(first, [state.update({ effects: setTabFocusMode.of(true) })]);
  registry.setLanguage(first, 'plaintext');
  const configured = reconfigureReadOnly(reconfigureLanguage(registry.getDocument(first)!.state, []), true);
  expect(configured.field(tabFocusMode)).toBe(true);
  expect(reconfigureReadOnly(configured, false).field(tabFocusMode)).toBe(true);
  expect(registry.getDocument(second)!.state.field(tabFocusMode)).toBe(false);
  expect(registry.getDocument(first)!.summary).toMatchObject({ version: 0, dirty: false });
});

it('read-only editor state still accepts a focus-mode effect without changing its text', () => {
  const state = createEditorState('read-only', true);
  const next = state.update({ effects: setTabFocusMode.of(true) }).state;
  expect(next.doc).toBe(state.doc);
  expect(next.selection).toBe(state.selection);
  expect(undoDepth(next)).toBe(0);
});

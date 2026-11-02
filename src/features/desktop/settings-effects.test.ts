import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { indentMore, undo, undoDepth } from '@codemirror/commands';
import { DocumentRegistry } from '../editor/documents';
import { SettingsCoordinator } from './settings';
import { applySettingsToEditors } from './settings-effects';

it('applies real CodeMirror preferences to current and newly created documents without making them dirty', () => {
  const settings = new SettingsCoordinator();
  const registry = new DocumentRegistry();
  const first = registry.createUntitled();
  const stop = applySettingsToEditors(settings, registry);
  settings.setSession('tabSize', 8); settings.setSession('insertSpaces', false);
  const second = registry.createUntitled();
  for (const id of [first, second]) {
    const document = registry.getDocument(id)!;
    expect(document.state.facet(EditorState.tabSize)).toBe(8);
    expect(document.state.facet(indentUnit)).toBe('\t');
    expect(document.summary).toMatchObject({ indentWidth: 8, indentOverridden: false, version: 0, dirty: false });
  }
  stop();
});

it('preserves text, cursor, version and undo when the wrapping and indentation preferences change', () => {
  const settings = new SettingsCoordinator(); const registry = new DocumentRegistry();
  const stop = applySettingsToEditors(settings, registry);
  const id = registry.createUntitled();
  const initial = registry.getDocument(id)!.state;
  registry.commit(id, [initial.update({ changes: { from: 0, insert: 'body' }, selection: { anchor: 3 } })]);
  const before = registry.getDocument(id)!;
  const version = before.summary.version; const depth = undoDepth(before.state);
  settings.setSession('wordWrap', false); settings.setSession('lineNumbers', false);
  settings.setSession('highlightActiveLine', false); settings.setSession('tabSize', 2);
  const after = registry.getDocument(id)!;
  expect(after.state.doc.toString()).toBe('body'); expect(after.state.selection.main.anchor).toBe(3);
  expect(after.summary.version).toBe(version); expect(undoDepth(after.state)).toBe(depth);
  expect(undo({ state: after.state, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe(''); stop();
});

it('document temporary indentation stays above the global default until explicitly reset', () => {
  const settings = new SettingsCoordinator(); const registry = new DocumentRegistry();
  const stop = applySettingsToEditors(settings, registry);
  const id = registry.createUntitled(); registry.setIndentWidth(id, 2);
  settings.setSession('tabSize', 8);
  expect(registry.getDocument(id)!.summary.indentWidth).toBe(2);
  registry.clearIndentOverride(id);
  expect(registry.getDocument(id)!.summary.indentWidth).toBe(8);
  settings.setSession('insertSpaces', false);
  const document = registry.getDocument(id)!;
  indentMore({ state: document.state, dispatch: transaction => { registry.commit(id, [transaction]); } });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('\t'); stop();
});

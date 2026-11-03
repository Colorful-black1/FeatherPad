import { Compartment, EditorState, Facet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { editorKeyboardFocus } from './keyboard-focus';
import { documentFormatExtensions, type DocumentFormatState } from './line-endings';

const editability = new Compartment();
const indentation = new Compartment();
const languageMode = new Compartment();
const matching = new Compartment();
const closing = new Compartment();
const appearance = new Compartment();
export type IndentWidth = 2 | 4 | 8;
export interface EditorPreferences {
  indentWidth: IndentWidth; insertSpaces: boolean; wordWrap: boolean; lineNumbers: boolean; highlightActiveLine: boolean;
}
export const defaultEditorPreferences: Readonly<EditorPreferences> = Object.freeze({
  indentWidth: 4, insertSpaces: true, wordWrap: true, lineNumbers: true, highlightActiveLine: true,
});
const appearanceSettings = Facet.define<EditorPreferences, EditorPreferences>({
  combine: values => values[0] ?? defaultEditorPreferences,
});
export interface SearchHighlight {
  from: number;
  to: number;
  current: boolean;
}
export const setSearchHighlights = StateEffect.define<readonly SearchHighlight[]>();
const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchHighlights)) continue;
      const ranges = effect.value
        .filter(marker => marker.from < marker.to)
        .map(marker => Decoration.mark({
          class: marker.current ? 'cm-searchMatch cm-searchMatch-current' : 'cm-searchMatch',
        }).range(marker.from, marker.to));
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});
export interface EditorStateOptions {
  documentFormat?: DocumentFormatState;
  indentWidth?: IndentWidth;
  language?: Extension;
  bracketMatching?: boolean;
  closeBrackets?: boolean;
  insertSpaces?: boolean;
  wordWrap?: boolean;
  lineNumbers?: boolean;
  highlightActiveLine?: boolean;
}

function accessExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({
    'aria-label': readOnly ? '文档内容（只读）' : '文档内容', 'aria-readonly': String(readOnly), tabindex: '0',
  })];
}

function indentationExtensions(indentWidth: IndentWidth, insertSpaces: boolean) {
  return [EditorState.tabSize.of(indentWidth), indentUnit.of(insertSpaces ? ' '.repeat(indentWidth) : '\t')];
}

function appearanceExtensions(settings: EditorPreferences) {
  return [appearanceSettings.of(settings), settings.wordWrap ? EditorView.lineWrapping : [],
    settings.lineNumbers ? lineNumbers() : [],
    settings.highlightActiveLine ? [highlightActiveLine(), highlightActiveLineGutter()] : []];
}

export function reconfigureEditorPreferences(state: EditorState, settings: EditorPreferences): EditorState {
  const current = state.facet(appearanceSettings);
  const next = reconfigureIndentation(state, settings.indentWidth, settings.insertSpaces);
  if (current.wordWrap === settings.wordWrap && current.lineNumbers === settings.lineNumbers
    && current.highlightActiveLine === settings.highlightActiveLine) return next;
  return next.update({ effects: appearance.reconfigure(appearanceExtensions(settings)) }).state;
}

export function reconfigureReadOnly(state: EditorState, readOnly: boolean): EditorState {
  return state.facet(EditorState.readOnly) === readOnly ? state : state.update({ effects: editability.reconfigure(accessExtensions(readOnly)) }).state;
}

export function reconfigureIndentation(state: EditorState, indentWidth: IndentWidth, insertSpaces = true): EditorState {
  return state.facet(EditorState.tabSize) === indentWidth && state.facet(indentUnit) === (insertSpaces ? ' '.repeat(indentWidth) : '\t')
    ? state
    : state.update({ effects: indentation.reconfigure(indentationExtensions(indentWidth, insertSpaces)) }).state;
}

export function reconfigureLanguage(state: EditorState, language: Extension): EditorState {
  return state.update({ effects: languageMode.reconfigure(language) }).state;
}

export function reconfigureBracketMatching(state: EditorState, enabled: boolean): EditorState {
  return state.update({ effects: matching.reconfigure(enabled ? bracketMatching() : []) }).state;
}

export function reconfigureCloseBrackets(state: EditorState, enabled: boolean): EditorState {
  return state.update({
    effects: closing.reconfigure(enabled ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
  }).state;
}

export function createEditorState(text: string, readOnly: boolean, options: EditorStateOptions = {}) {
  const indentWidth = options.indentWidth ?? 4;
  const preferences = { ...defaultEditorPreferences, ...options, indentWidth };
  return EditorState.create({
    doc: text,
    extensions: [
      editorKeyboardFocus,
      documentFormatExtensions(options.documentFormat),
      history(), closing.of(options.closeBrackets === false ? [] : [closeBrackets(), keymap.of(closeBracketsKeymap)]),
      keymap.of([
        indentWithTab,
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      indentation.of(indentationExtensions(indentWidth, preferences.insertSpaces)),
      appearance.of(appearanceExtensions(preferences)),
      languageMode.of(options.language ?? []),
      matching.of(options.bracketMatching === false ? [] : bracketMatching()),
      searchHighlightField,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      editability.of(accessExtensions(readOnly)),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--bg-editor)', color: 'var(--text-primary)' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--editor-size)', overflow: 'auto' },
        '.cm-gutters': { backgroundColor: 'var(--bg-editor)', color: 'var(--text-muted)', borderRight: 'none' },
        '.cm-content': { padding: '16px 0', lineHeight: 'var(--editor-line-height, 1.85)' },
        '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
      }),
    ],
  });
}

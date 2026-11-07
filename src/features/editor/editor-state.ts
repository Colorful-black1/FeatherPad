import { Compartment, EditorState, Facet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightTrailingWhitespace, highlightWhitespace, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { editorKeyboardFocus } from './keyboard-focus';
import { documentFormatExtensions, type DocumentFormatState } from './line-endings';
import {
  defaultEditingCommandBindings,
  editingKeymap,
  editingLanguageExtensions,
  languageIdFacet,
  type EditingCommandBindings,
} from './editing';
import type { LanguageId } from './editor-language';

// Colors come from semantic tokens so the editor follows the light or dark
// workbench theme instead of CodeMirror's fixed light palette.
const themedHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: 'var(--text-muted)' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: 'var(--syntax-atom)' },
  { tag: [tags.literal, tags.inserted], color: 'var(--syntax-string)' },
  { tag: [tags.string, tags.deleted], color: 'var(--syntax-string)' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: 'var(--syntax-escape)' },
  { tag: tags.definition(tags.variableName), color: 'var(--syntax-variable)' },
  { tag: tags.local(tags.variableName), color: 'var(--syntax-variable)' },
  { tag: [tags.typeName, tags.namespace, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.special(tags.variableName), tags.macroName], color: 'var(--syntax-property)' },
  { tag: tags.definition(tags.propertyName), color: 'var(--syntax-property)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
  { tag: tags.tagName, color: 'var(--syntax-tag)' },
  { tag: tags.attributeName, color: 'var(--syntax-attribute)' },
  { tag: tags.attributeValue, color: 'var(--syntax-string)' },
  { tag: tags.angleBracket, color: 'var(--syntax-punctuation)' },
  { tag: [tags.definitionOperator, tags.derefOperator, tags.separator], color: 'var(--syntax-punctuation)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.character, tags.special(tags.character)], color: 'var(--syntax-escape)' },
  { tag: [tags.processingInstruction, tags.documentMeta], color: 'var(--text-muted)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

const editability = new Compartment();
const indentation = new Compartment();
const languageMode = new Compartment();
const matching = new Compartment();
const closing = new Compartment();
const appearance = new Compartment();
const editingLanguage = new Compartment();
const editingKeys = new Compartment();
const whitespace = new Compartment();
export type IndentWidth = 2 | 4 | 8;
export type WhitespaceMode = 'none' | 'current' | 'all';
export interface EditorPreferences {
  indentWidth: IndentWidth; insertSpaces: boolean; wordWrap: boolean; lineNumbers: boolean; highlightActiveLine: boolean;
  whitespaceMode: WhitespaceMode; folding: boolean;
}
export const defaultEditorPreferences: Readonly<EditorPreferences> = Object.freeze({
  indentWidth: 4, insertSpaces: true, wordWrap: true, lineNumbers: true, highlightActiveLine: true,
  whitespaceMode: 'none', folding: true,
});
const appearanceSettings = Facet.define<EditorPreferences, EditorPreferences>({
  combine: values => values[0] ?? defaultEditorPreferences,
});
const whitespaceMode = Facet.define<WhitespaceMode, WhitespaceMode>({
  combine: values => values[0] ?? 'none',
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
  whitespaceMode?: WhitespaceMode;
  folding?: boolean;
  languageId?: LanguageId;
  commandBindings?: EditingCommandBindings;
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

function currentLineWhitespaceDecoration(lineText: string, lineFrom: number) {
  const ranges = [];
  for (const match of lineText.matchAll(/[ \t]+/g)) {
    const from = lineFrom + (match.index ?? 0);
    ranges.push(Decoration.mark({ class: 'cm-whitespace cm-current-line-whitespace' })
      .range(from, from + match[0].length));
  }
  return ranges;
}

function currentLineWhitespace(): Extension {
  const decorations = StateField.define<DecorationSet>({
    create(state) {
      const line = state.doc.lineAt(state.selection.main.head);
      return Decoration.set(currentLineWhitespaceDecoration(line.text, line.from), true);
    },
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.selection) return value;
      const line = transaction.state.doc.lineAt(transaction.state.selection.main.head);
      return Decoration.set(currentLineWhitespaceDecoration(line.text, line.from), true);
    },
    provide: field => EditorView.decorations.from(field),
  });
  return decorations;
}

function whitespaceExtensions(mode: WhitespaceMode): Extension {
  return [
    whitespaceMode.of(mode),
    mode === 'all' ? [highlightWhitespace(), highlightTrailingWhitespace()]
      : mode === 'current' ? currentLineWhitespace() : [],
  ];
}

export function reconfigureEditorPreferences(state: EditorState, settings: EditorPreferences): EditorState {
  const current = state.facet(appearanceSettings);
  let next = reconfigureIndentation(state, settings.indentWidth, settings.insertSpaces);
  if (state.facet(whitespaceMode) !== settings.whitespaceMode) {
    next = next.update({ effects: whitespace.reconfigure(whitespaceExtensions(settings.whitespaceMode)) }).state;
  }
  const languageId = next.facet(languageIdFacet);
  const foldingChanged = current.folding !== settings.folding;
  if (foldingChanged) {
    next = next.update({
      effects: editingLanguage.reconfigure(editingLanguageExtensions(languageId, settings.folding)),
    }).state;
  }
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

export function reconfigureLanguage(state: EditorState, language: Extension,
  languageId = state.facet(languageIdFacet), folding = state.facet(appearanceSettings).folding): EditorState {
  return state.update({
    effects: [
      languageMode.reconfigure(language),
      editingLanguage.reconfigure(editingLanguageExtensions(languageId, folding)),
    ],
  }).state;
}

export function reconfigureBracketMatching(state: EditorState, enabled: boolean): EditorState {
  return state.update({ effects: matching.reconfigure(enabled ? bracketMatching() : []) }).state;
}

export function reconfigureCloseBrackets(state: EditorState, enabled: boolean): EditorState {
  return state.update({
    effects: closing.reconfigure(enabled ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
  }).state;
}

export function reconfigureEditingBindings(state: EditorState, bindings: EditingCommandBindings): EditorState {
  return state.update({ effects: editingKeys.reconfigure(editingKeymap(bindings)) }).state;
}

export function createEditorState(text: string, readOnly: boolean, options: EditorStateOptions = {}) {
  const indentWidth = options.indentWidth ?? 4;
  const preferences = { ...defaultEditorPreferences, ...options, indentWidth };
  const languageId = options.languageId ?? 'plaintext';
  return EditorState.create({
    doc: text,
    extensions: [
      editorKeyboardFocus,
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      EditorView.clickAddsSelectionRange.of(event => event.altKey),
      documentFormatExtensions(options.documentFormat),
      history(), closing.of(options.closeBrackets === false ? [] : [closeBrackets(), keymap.of(closeBracketsKeymap)]),
      keymap.of([
        indentWithTab,
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      editingKeys.of(editingKeymap(options.commandBindings ?? defaultEditingCommandBindings)),
      indentation.of(indentationExtensions(indentWidth, preferences.insertSpaces)),
      appearance.of(appearanceExtensions(preferences)),
      languageMode.of(options.language ?? []),
      editingLanguage.of(editingLanguageExtensions(languageId, preferences.folding)),
      whitespace.of(whitespaceExtensions(preferences.whitespaceMode)),
      matching.of(options.bracketMatching === false ? [] : bracketMatching()),
      searchHighlightField,
      syntaxHighlighting(themedHighlightStyle, { fallback: true }),
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

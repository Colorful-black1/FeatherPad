import {
  copyLineDown,
  copyLineUp,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  toggleBlockComment,
  toggleComment,
} from '@codemirror/commands';
import {
  autocompletion,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { codeFolding, foldCode, foldGutter, foldKeymap, unfoldCode } from '@codemirror/language';
import { EditorSelection, EditorState, Facet, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import type { LanguageId } from './editor-language';

const MAX_COMPLETION_DOCUMENT_CHARS = 1_000_000;
const MAX_COMPLETIONS = 100;
const completionWord = /[\p{L}_][\p{L}\p{N}_-]{1,63}/gu;
const wordCharacter = /[\p{L}\p{N}_-]/u;

const languageKeywords: Readonly<Partial<Record<LanguageId, readonly string[]>>> = Object.freeze({
  json: ['true', 'false', 'null'],
  jsonc: ['true', 'false', 'null'],
  javascript: ['const', 'let', 'function', 'return', 'class', 'async', 'await', 'import', 'export', 'true', 'false', 'null'],
  typescript: ['interface', 'type', 'const', 'let', 'function', 'return', 'class', 'async', 'await', 'import', 'export', 'true', 'false', 'null'],
  java: ['class', 'interface', 'public', 'private', 'protected', 'static', 'final', 'return', 'new', 'true', 'false', 'null'],
  rust: ['fn', 'let', 'mut', 'struct', 'enum', 'trait', 'impl', 'match', 'return', 'true', 'false'],
  python: ['def', 'class', 'import', 'from', 'return', 'yield', 'async', 'await', 'True', 'False', 'None'],
  sql: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'GROUP', 'ORDER', 'INSERT', 'UPDATE', 'DELETE', 'NULL'],
  yaml: ['true', 'false', 'null'],
  shell: ['if', 'then', 'else', 'fi', 'for', 'in', 'do', 'done', 'case', 'esac', 'export'],
});

function documentWords(state: EditorState): string[] {
  const text = state.doc.sliceString(0, Math.min(state.doc.length, MAX_COMPLETION_DOCUMENT_CHARS));
  const words = new Set<string>();
  for (const match of text.matchAll(completionWord)) {
    words.add(match[0]);
    if (words.size >= MAX_COMPLETIONS * 4) break;
  }
  return [...words];
}

export function documentWordCompletions(context: CompletionContext): CompletionResult | null {
  if (context.state.facet(EditorState.readOnly)) return null;
  const word = context.matchBefore(/[\p{L}_][\p{L}\p{N}_-]{0,63}/u);
  if (!word || (!context.explicit && word.to - word.from < 2)) return null;
  const current = word.from < word.to ? context.state.sliceDoc(word.from, word.to) : '';
  const byName = new Map<string, Completion>();
  for (const option of documentWords(context.state)) {
    if (option !== current) byName.set(option, { label: option, type: 'text', detail: '本文档' });
    if (byName.size >= MAX_COMPLETIONS) break;
  }
  const typed = current.toLocaleLowerCase();
  for (const keyword of languageKeywords[context.state.facet(languageIdFacet)] ?? []) {
    if (keyword.toLocaleLowerCase().startsWith(typed)) {
      byName.set(keyword, { label: keyword, type: 'keyword', detail: '语言关键字' });
    }
  }
  const options = [...byName.values()].slice(0, MAX_COMPLETIONS);
  return options.length > 0
    ? { from: word.from, to: word.to, options, validFor: /^[\p{L}\p{N}_-]*$/u }
    : null;
}

export const languageIdFacet = Facet.define<LanguageId, LanguageId>({
  combine: values => values[0] ?? 'plaintext',
});

function commentTokens(languageId: LanguageId) {
  if (languageId === 'python' || languageId === 'yaml' || languageId === 'shell' || languageId === 'toml') {
    return { line: '#', block: { open: '/*', close: '*/' } };
  }
  if (languageId === 'sql') return { line: '--', block: { open: '/*', close: '*/' } };
  if (languageId === 'javascript' || languageId === 'typescript' || languageId === 'java'
    || languageId === 'rust' || languageId === 'jsonc') {
    return { line: '//', block: { open: '/*', close: '*/' } };
  }
  if (languageId === 'markdown' || languageId === 'xml' || languageId === 'html') {
    return { block: { open: '<!--', close: '-->' } };
  }
  if (languageId === 'css') return { block: { open: '/*', close: '*/' } };
  return null;
}

export function commentLanguageData(languageId: LanguageId): Extension {
  const tokens = commentTokens(languageId);
  return tokens ? EditorState.languageData.of(() => [{ commentTokens: tokens }]) : [];
}

export function editingLanguageExtensions(languageId: LanguageId, foldingEnabled: boolean): Extension {
  const comments = commentLanguageData(languageId);
  const completion = autocompletion({
    override: [documentWordCompletions],
    activateOnTyping: true,
    maxRenderedOptions: MAX_COMPLETIONS,
  });
  const folding = foldingEnabled && languageId !== 'plaintext'
    ? [codeFolding(), foldGutter(), keymap.of(foldKeymap)]
    : [];
  return [
    languageIdFacet.of(languageId),
    comments,
    completion,
    keymap.of(completionKeymap),
    folding,
  ];
}

function announceUnavailable(view: EditorView, command: '行' | '块') {
  view.dispatch({
    effects: EditorView.announce.of(`当前语言不支持${command}注释；请先选择支持该注释的语法模式。`),
  });
}

const toggleCommentWithReason: Command = view => {
  if (toggleComment(view)) return true;
  announceUnavailable(view, '行');
  return true;
};

const toggleBlockCommentWithReason: Command = view => {
  if (toggleBlockComment(view)) return true;
  announceUnavailable(view, '块');
  return true;
};

const toggleFoldWithReason: Command = view => {
  if (foldCode(view) || unfoldCode(view)) return true;
  view.dispatch({
    effects: EditorView.announce.of('当前行没有可折叠代码块；纯文本模式不提供代码折叠。'),
  });
  return true;
};

function selectedWordRange(state: EditorState) {
  const main = state.selection.main;
  if (!main.empty) return EditorSelection.range(main.from, main.to);
  const line = state.doc.lineAt(main.head);
  let from = main.head;
  let to = main.head;
  while (from > line.from && wordCharacter.test(state.sliceDoc(from - 1, from))) from--;
  while (to < line.to && wordCharacter.test(state.sliceDoc(to, to + 1))) to++;
  return from < to ? EditorSelection.range(from, to) : null;
}

function occurrenceRanges(text: string, range: SelectionRange): SelectionRange[] {
  const needle = text.slice(range.from, range.to);
  if (!needle) return [range];
  const ranges: SelectionRange[] = [];
  let offset = 0;
  while (offset <= text.length - needle.length && ranges.length < 10_000) {
    const found = text.indexOf(needle, offset);
    if (found < 0) break;
    ranges.push(EditorSelection.range(found, found + needle.length));
    offset = found + Math.max(1, needle.length);
  }
  return ranges.length > 0 ? ranges : [range];
}

export const selectNextOccurrence: Command = ({ state, dispatch }) => {
  const selected = selectedWordRange(state);
  if (!selected) return false;
  if (state.selection.main.empty) {
    dispatch(state.update({
      selection: EditorSelection.single(selected.from, selected.to),
      scrollIntoView: true,
      userEvent: 'select.nextOccurrence',
    }));
    return true;
  }

  const text = state.doc.toString();
  const known = new Set(state.selection.ranges.map(range => `${range.from}:${range.to}`));
  const next = occurrenceRanges(text, selected).find(range => !known.has(`${range.from}:${range.to}`));
  if (!next) return false;
  const ranges = [...state.selection.ranges, next];
  dispatch(state.update({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    scrollIntoView: true,
    userEvent: 'select.nextOccurrence',
  }));
  return true;
};

export const selectAllOccurrences: Command = ({ state, dispatch }) => {
  const selected = selectedWordRange(state);
  if (!selected) return false;
  const ranges = occurrenceRanges(state.doc.toString(), selected);
  if (ranges.length < 2) return false;
  dispatch(state.update({
    selection: EditorSelection.create(ranges, 0),
    scrollIntoView: true,
    userEvent: 'select.allOccurrences',
  }));
  return true;
};

export const editingCommands = Object.freeze({
  toggleComment: toggleCommentWithReason,
  toggleBlockComment: toggleBlockCommentWithReason,
  toggleFold: toggleFoldWithReason,
  moveLineUp,
  moveLineDown,
  copyLineUp,
  copyLineDown,
  insertBlankLine,
  startCompletion,
  selectNextOccurrence,
  selectAllOccurrences,
});

export type EditingCommandId = keyof typeof editingCommands;
export type EditingCommandBindings = Readonly<Partial<Record<EditingCommandId, string | null>>>;

export const defaultEditingCommandBindings: Readonly<Record<EditingCommandId, string | null>> = Object.freeze({
  toggleComment: 'Ctrl+/',
  toggleBlockComment: 'Shift+Alt+A',
  toggleFold: null,
  moveLineUp: 'Alt+ArrowUp',
  moveLineDown: 'Alt+ArrowDown',
  copyLineUp: 'Shift+Alt+ArrowUp',
  copyLineDown: 'Shift+Alt+ArrowDown',
  insertBlankLine: 'Ctrl+Enter',
  startCompletion: 'Ctrl+Space',
  selectNextOccurrence: 'Ctrl+D',
  selectAllOccurrences: 'Ctrl+Shift+L',
});

function codeMirrorKey(binding: string): string | null {
  const parts = binding.split('+');
  const key = parts.pop();
  if (!key) return null;
  const keyName = key === 'Space' ? 'Space' : key.length === 1 ? key.toLocaleLowerCase() : key;
  return [...parts.map(modifier => modifier === 'Ctrl' ? 'Ctrl' : modifier), keyName].join('-');
}

export function editingKeymap(bindings: EditingCommandBindings = defaultEditingCommandBindings): Extension {
  const shortcuts = (Object.entries(editingCommands) as [EditingCommandId, Command][]).flatMap(([id, command]) => {
    const binding = Object.hasOwn(bindings, id) ? bindings[id] : defaultEditingCommandBindings[id];
    const key = binding ? codeMirrorKey(binding) : null;
    return key ? [{ key, run: command, preventDefault: true }] : [];
  });
  return keymap.of(shortcuts);
}

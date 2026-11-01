import { EditorState } from '@codemirror/state';

export interface EditorMetrics {
  readonly line: number;
  readonly column: number;
  readonly characterCount: number;
  readonly selectedCharacterCount: number;
  readonly selectionCount: number;
}

export function countCharacters(value: string): number {
  const surrogatePairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g);
  return value.length - (surrogatePairs?.length ?? 0);
}

export function visualColumn(lineText: string, offset: number, tabSize: number): number {
  let column = 0;
  for (const character of lineText.slice(0, offset)) {
    column = character === '\t' ? column + tabSize - column % tabSize : column + 1;
  }
  return column + 1;
}

export function editorMetrics(state: EditorState, characterCount: number): EditorMetrics {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const nonEmpty = state.selection.ranges.filter(range => !range.empty);
  return {
    line: line.number,
    column: visualColumn(line.text, head - line.from, state.facet(EditorState.tabSize)),
    characterCount,
    selectedCharacterCount: nonEmpty.reduce((total, range) => total + countCharacters(state.sliceDoc(range.from, range.to)), 0),
    selectionCount: nonEmpty.length,
  };
}

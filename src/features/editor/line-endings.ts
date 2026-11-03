import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import type { TextFormat } from '../../shared/contracts/files';

export type Newline = 'lf' | 'crlf' | 'cr';
export interface DocumentFormatState {
  readonly format: Readonly<TextFormat>;
  readonly endings: readonly Newline[];
  readonly insertionEnding: Newline;
}

export function dominantEnding(endings: readonly Newline[]): Newline {
  const counts = { lf: 0, crlf: 0, cr: 0 };
  for (const ending of endings) counts[ending]++;
  // Iterating original order resolves ties in favor of the first original token.
  let result: Newline = endings[0] ?? 'crlf';
  for (const ending of endings) if (counts[ending] > counts[result]) result = ending;
  return result;
}

export function formatState(format: Readonly<TextFormat>, endings: readonly Newline[]): DocumentFormatState {
  return { format: { ...format }, endings: [...endings],
    insertionEnding: format.lineEnding === 'mixed' ? dominantEnding(endings) : format.lineEnding };
}

export function sameDocumentFormat(a: DocumentFormatState, b: DocumentFormatState): boolean {
  return a === b || (a.format.encoding === b.format.encoding && a.format.bom === b.format.bom
    && a.format.lineEnding === b.format.lineEnding && a.endings.length === b.endings.length
    && a.endings.every((ending, index) => ending === b.endings[index]));
}

export const setDocumentFormat = StateEffect.define<DocumentFormatState>();
export const documentFormat = StateField.define<DocumentFormatState>({
  create: state => formatState({ encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
    Array.from({ length: state.doc.lines - 1 }, () => 'crlf')),
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) {
      const edits: { start: number; end: number; count: number }[] = [];
      transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
        const start = transaction.startState.doc.lineAt(from).number - 1;
        const end = transaction.startState.doc.lineAt(to).number - 1;
        const count = inserted.lines - 1;
        if (start !== end || count !== 0) edits.push({ start, end, count });
      });
      if (edits.length) {
        const endings: Newline[] = [];
        let cursor = 0;
        for (const edit of edits) {
          for (; cursor < edit.start; cursor++) endings.push(value.endings[cursor]!);
          for (let index = 0; index < edit.count; index++) endings.push(value.insertionEnding);
          cursor = edit.end;
        }
        for (; cursor < value.endings.length; cursor++) endings.push(value.endings[cursor]!);
        next = { ...value, endings };
      }
    }
    for (const effect of transaction.effects) if (effect.is(setDocumentFormat)) next = effect.value;
    if (next.endings.length !== transaction.newDoc.lines - 1) throw new Error('逐行换行映射与正文不一致。');
    return next;
  },
});

export function documentFormatExtensions(initial?: DocumentFormatState): Extension {
  return [initial ? documentFormat.init(() => initial) : documentFormat,
    invertedEffects.of(transaction => {
      const before = transaction.startState.field(documentFormat);
      const after = transaction.state.field(documentFormat);
      return sameDocumentFormat(before, after) ? [] : [setDocumentFormat.of(before)];
    })];
}

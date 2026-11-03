import type { Newline } from '../editor/line-endings';

export const textOperations = ['sort', 'unique', 'upper', 'lower', 'trim', 'final-newline', 'remove-final-newlines', 'tabs-to-spaces', 'spaces-to-tabs'] as const;
export type TextOperation = typeof textOperations[number];
export interface TransformOptions { natural: boolean; descending: boolean; caseSensitive: boolean; keepEmpty: boolean; tabSize: 2 | 4 | 8 }
export const defaultTransformOptions: TransformOptions = { natural: false, descending: false, caseSensitive: true, keepEmpty: true, tabSize: 2 };
export interface TransformRequest {
  requestId: string; documentId: string; version: number; text: string; endings: readonly Newline[]; insertionEnding: Newline;
  from: number; to: number; operation: TextOperation; options: TransformOptions;
}
export type TransformReply = Pick<TransformRequest, 'requestId' | 'documentId' | 'version'> &
  ({ ok: true; text: string; replacement: string; endings: Newline[]; changedLines: number } | { ok: false; message: string });

function codepointCompare(a: string, b: string): number {
  let left = 0, right = 0;
  while (left < a.length && right < b.length) {
    const x = a.codePointAt(left)!, y = b.codePointAt(right)!;
    if (x !== y) return x < y ? -1 : 1;
    left += x > 0xffff ? 2 : 1; right += y > 0xffff ? 2 : 1;
  }
  return left < a.length ? 1 : right < b.length ? -1 : 0;
}
function naturalCompare(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? [], right = b.match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index]!, y = right[index]!;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const nx = x.replace(/^0+/, '') || '0', ny = y.replace(/^0+/, '') || '0';
      const compare = nx.length - ny.length || codepointCompare(nx, ny);
      if (compare) return compare;
    } else { const compare = codepointCompare(x, y); if (compare) return compare; }
  }
  return left.length - right.length;
}
const newlineCount = (text: string) => text.split('\n').length - 1;
interface Row { text: string; id: number; ending: Newline | null }

function reorder(source: string, endings: readonly Newline[], insertion: Newline, operation: 'sort' | 'unique', options: TransformOptions) {
  const finalNewline = source.endsWith('\n');
  const parts = source.split('\n'); if (finalNewline) parts.pop();
  let rows: Row[] = parts.map((text, id) => ({ text, id, ending: endings[id] ?? null }));
  if (!options.keepEmpty) rows = rows.filter(row => !/^[ \t]*$/.test(row.text));
  const key = (row: Row) => options.caseSensitive ? row.text : row.text.toLowerCase();
  if (operation === 'sort') rows.sort((a, b) =>
    (options.natural ? naturalCompare(key(a), key(b)) : codepointCompare(key(a), key(b))) * (options.descending ? -1 : 1) || a.id - b.id);
  else {
    const seen = new Set<string>();
    rows = rows.filter(row => {
      if (options.keepEmpty && /^[ \t]*$/.test(row.text)) return true;
      const value = key(row); if (seen.has(value)) return false; seen.add(value); return true;
    });
  }
  // Keep each retained line's token where possible. If an unterminated final
  // line moves to the middle, reuse an orphaned original token before inserting
  // the document's chosen default. Preserve the original final-newline intent.
  const needs = rows.map((_row, index) => index < rows.length - 1 || finalNewline);
  const used = new Set(rows.filter((row, index) => needs[index] && row.ending).map(row => row.id));
  const spare = endings.filter((_ending, index) => !used.has(index));
  const outputEndings: Newline[] = [];
  const text = rows.map((row, index) => {
    if (!needs[index]) return row.text;
    outputEndings.push(row.ending ?? spare.shift() ?? insertion);
    return row.text + '\n';
  }).join('');
  return { text, endings: outputEndings };
}

function indentation(line: string, tabSize: number, toTabs: boolean): string {
  const prefix = /^[ \t]*/.exec(line)![0]; let width = 0;
  for (const char of prefix) width += char === '\t' ? tabSize - width % tabSize : 1;
  const next = toTabs ? '\t'.repeat(Math.floor(width / tabSize)) + ' '.repeat(width % tabSize) : ' '.repeat(width);
  return next + line.slice(prefix.length);
}

export function transformText(request: TransformRequest): TransformReply {
  const identity = { requestId: request.requestId, documentId: request.documentId, version: request.version };
  const { text, endings, from, to, operation, options } = request;
  const splitsPair = (offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > text.length || text.includes('\r')
    || !textOperations.includes(operation) || endings.length !== newlineCount(text) || splitsPair(from) || splitsPair(to)
    || endings.some(ending => !['lf', 'crlf', 'cr'].includes(ending)) || !['lf', 'crlf', 'cr'].includes(request.insertionEnding)
    || new TextEncoder().encode(text).byteLength >= 20 * 1024 * 1024 || ![2, 4, 8].includes(options.tabSize)) {
    return { ...identity, ok: false, message: '文本工具范围、换行映射或大小无效，正文未修改。' };
  }
  const scope = text.slice(from, to), prefixCount = newlineCount(text.slice(0, from));
  const count = newlineCount(scope), localEndings = endings.slice(prefixCount, prefixCount + count);
  let replacement = scope, nextEndings = [...localEndings];
  if (operation === 'sort' || operation === 'unique') {
    const result = reorder(scope, localEndings, request.insertionEnding, operation, options);
    replacement = result.text; nextEndings = result.endings;
  } else if (operation === 'upper') replacement = scope.toUpperCase();
  else if (operation === 'lower') replacement = scope.toLowerCase();
  else if (operation === 'trim') replacement = scope.replace(/[ \t]+$/gm, '');
  else if (operation === 'final-newline' && !scope.endsWith('\n')) { replacement += '\n'; nextEndings.push(request.insertionEnding); }
  else if (operation === 'remove-final-newlines') { replacement = scope.replace(/\n+$/, ''); nextEndings = nextEndings.slice(0, newlineCount(replacement)); }
  else if (operation === 'tabs-to-spaces' || operation === 'spaces-to-tabs') {
    replacement = scope.split('\n').map((line, index) => index === 0 && from > 0 && text[from - 1] !== '\n'
      ? line : indentation(line, options.tabSize, operation === 'spaces-to-tabs')).join('\n');
  }
  const originalLines = scope.split('\n'), changedLines = replacement.split('\n');
  const changed = Math.max(originalLines.length, changedLines.length) - originalLines.filter((line, index) => changedLines[index] === line).length;
  const output = text.slice(0, from) + replacement + text.slice(to);
  if (new TextEncoder().encode(output).byteLength >= 20 * 1024 * 1024) return { ...identity, ok: false, message: '文本工具结果超过20MiB，未应用。' };
  return { ...identity, ok: true, text: output, replacement,
    endings: [...endings.slice(0, prefixCount), ...nextEndings, ...endings.slice(prefixCount + count)], changedLines: changed };
}

import { diffLines, type DiffRange, type LineDiff } from './line-diff';

export interface DiffRequest { requestId: string; left: string; right: string; ignoreWhitespace: boolean }
export interface DiffReply extends LineDiff { requestId: string }

function offsets(text: string): number[] {
  const result = [0]; for (let index = 0; index < text.length; index++) if (text[index] === '\n') result.push(index + 1);
  return result;
}
function rangeMapper(normalized: string, original: string): (range: DiffRange) => DiffRange {
  const normalOffsets = offsets(normalized), originalOffsets = offsets(original);
  const position = (offset: number) => {
    if (offset === normalized.length) return original.length;
    let low = 0, high = normalOffsets.length;
    while (low < high) { const mid = (low + high) >>> 1; if (normalOffsets[mid]! <= offset) low = mid + 1; else high = mid; }
    return originalOffsets[Math.max(0, low - 1)]!;
  };
  return range => ({ from: position(range.from), to: position(range.to) });
}
export function diffSnapshots(request: DiffRequest): DiffReply {
  const left = request.ignoreWhitespace ? request.left.replace(/[ \t]+/g, '') : request.left;
  const right = request.ignoreWhitespace ? request.right.replace(/[ \t]+/g, '') : request.right;
  const diff = diffLines(left, right);
  const mapLeft = request.ignoreWhitespace ? rangeMapper(left, request.left) : (range: DiffRange) => range;
  const mapRight = request.ignoreWhitespace ? rangeMapper(right, request.right) : (range: DiffRange) => range;
  return { requestId: request.requestId, ...diff, changes: request.ignoreWhitespace ? diff.changes.map(change => ({
    memory: mapLeft(change.memory), disk: mapRight(change.disk),
  })) : diff.changes };
}

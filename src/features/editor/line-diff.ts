export interface DiffRange { from: number; to: number }
export interface DiffChange { memory: DiffRange; disk: DiffRange }
export interface LineDiff { changes: readonly DiffChange[]; coarse: boolean }
interface Lines { values: string[]; offsets: number[] }

// Bound allocation and quadratic refinement. Large unmatched regions remain exact
// changed blocks, with a visible coarse flag rather than an invented minimal diff.
function lines(text: string): Lines | null {
  const values: string[] = [], offsets = [0];
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    values.push(text.slice(from, index + 1)); offsets.push(index + 1); from = index + 1;
    if (values.length >= 50_000) return null;
  }
  if (from < text.length) { values.push(text.slice(from)); offsets.push(text.length); }
  return { values, offsets };
}

export function diffLines(memory: string, disk: string): LineDiff {
  if (memory === disk) return { changes: [], coarse: false };
  const a = lines(memory), b = lines(disk);
  if (!a || !b) return { changes: [{ memory: { from: 0, to: memory.length }, disk: { from: 0, to: disk.length } }], coarse: true };
  let first = 0, endA = a.values.length, endB = b.values.length;
  while (first < endA && first < endB && a.values[first] === b.values[first]) first++;
  while (endA > first && endB > first && a.values[endA - 1] === b.values[endB - 1]) { endA--; endB--; }
  const unique = (values: string[], end: number) => {
    const map = new Map<string, number>();
    for (let index = first; index < end; index++) map.set(values[index]!, map.has(values[index]!) ? -1 : index);
    return map;
  };
  const uniqueA = unique(a.values, endA), uniqueB = unique(b.values, endB);
  const pairs: [number, number][] = [];
  for (let index = first; index < endA; index++) {
    const other = uniqueB.get(a.values[index]!);
    if (uniqueA.get(a.values[index]!) === index && other !== undefined && other >= 0) pairs.push([index, other]);
  }
  // Increasing unique-line anchors keep refinement deterministic and O(n log n).
  const tails: number[] = [], parents: number[] = [];
  for (let index = 0; index < pairs.length; index++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]!]![1] < pairs[index]![1]) low = mid + 1; else high = mid; }
    parents[index] = low ? tails[low - 1]! : -1; tails[low] = index;
  }
  const anchors: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = parents[index]!) anchors.push(pairs[index]!);
  anchors.reverse(); anchors.push([endA, endB]);
  const changes: DiffChange[] = [];
  let fromA = first, fromB = first, budget = 500_000, coarse = false;
  function add(startA: number, stopA: number, startB: number, stopB: number) {
    if (startA === stopA && startB === stopB) return;
    changes.push({ memory: { from: a!.offsets[startA]!, to: a!.offsets[stopA]! },
      disk: { from: b!.offsets[startB]!, to: b!.offsets[stopB]! } });
  }
  for (const [toA, toB] of anchors) {
    const height = toA - fromA, width = toB - fromB, cells = (height + 1) * (width + 1);
    if (!height || !width) add(fromA, toA, fromB, toB);
    else if (cells > 16_384 || cells > budget) { add(fromA, toA, fromB, toB); coarse = true; }
    else {
      budget -= cells;
      const table = new Uint16Array(cells), stride = width + 1;
      for (let row = height - 1; row >= 0; row--) for (let column = width - 1; column >= 0; column--) {
        table[row * stride + column] = a.values[fromA + row] === b.values[fromB + column]
          ? table[(row + 1) * stride + column + 1]! + 1
          : Math.max(table[(row + 1) * stride + column]!, table[row * stride + column + 1]!);
      }
      let row = 0, column = 0, startA = fromA, startB = fromB;
      while (row < height || column < width) {
        if (row < height && column < width && a.values[fromA + row] === b.values[fromB + column]) {
          add(startA, fromA + row, startB, fromB + column);
          row++; column++; startA = fromA + row; startB = fromB + column;
        } else if (column < width && (row === height || table[row * stride + column + 1]! >= table[(row + 1) * stride + column]!)) column++;
        else row++;
      }
      add(startA, toA, startB, toB);
    }
    fromA = toA + 1; fromB = toB + 1;
  }
  return { changes, coarse };
}

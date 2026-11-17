export interface ChangedLineIndexes {
  before: ReadonlySet<number>;
  after: ReadonlySet<number>;
}

/** Marks lines that differ between the before/after preview of one hunk. */
export function changedLineIndexes(before: readonly string[], after: readonly string[]): ChangedLineIndexes {
  const beforeChanged = new Set<number>();
  const afterChanged = new Set<number>();
  const rows = before.length;
  const cols = after.length;
  if (rows === 0) {
    for (let column = 0; column < cols; column++) afterChanged.add(column);
    return { before: beforeChanged, after: afterChanged };
  }
  if (cols === 0) {
    for (let row = 0; row < rows; row++) beforeChanged.add(row);
    return { before: beforeChanged, after: afterChanged };
  }

  const lengths = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let row = rows - 1; row >= 0; row--) {
    const current = lengths[row]!;
    const next = lengths[row + 1]!;
    for (let column = cols - 1; column >= 0; column--) {
      current[column] = before[row] === after[column]
        ? next[column + 1]! + 1
        : Math.max(next[column]!, current[column + 1]!);
    }
  }

  let row = 0;
  let column = 0;
  while (row < rows && column < cols) {
    if (before[row] === after[column]) {
      row++;
      column++;
    } else if (lengths[row + 1]![column]! >= lengths[row]![column + 1]!) {
      beforeChanged.add(row++);
    } else {
      afterChanged.add(column++);
    }
  }
  while (row < rows) beforeChanged.add(row++);
  while (column < cols) afterChanged.add(column++);
  return { before: beforeChanged, after: afterChanged };
}

export function lineRangeLabel(startLine: number, count: number): string {
  if (count <= 1) return `第 ${startLine} 行`;
  return `第 ${startLine}–${startLine + count - 1} 行`;
}

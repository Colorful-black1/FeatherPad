import { expect, it } from 'vitest';
import { diffLines } from './line-diff';

function reconstructed(memory: string, disk: string) {
  const diff = diffLines(memory, disk);
  let result = '', cursor = 0;
  for (const change of diff.changes) {
    expect(change.memory.from).toBeGreaterThanOrEqual(cursor);
    result += memory.slice(cursor, change.memory.from) + disk.slice(change.disk.from, change.disk.to);
    cursor = change.memory.to;
  }
  return { diff, text: result + memory.slice(cursor) };
}

it('isolates inserted, deleted and changed lines with exact snapshot offsets', () => {
  expect(diffLines('a\nb\nc\n', 'a\nchanged\nc\n').changes).toEqual([
    { memory: { from: 2, to: 4 }, disk: { from: 2, to: 10 } },
  ]);
  expect(diffLines('a\nc', 'a\nb\nc').changes).toEqual([
    { memory: { from: 2, to: 2 }, disk: { from: 2, to: 4 } },
  ]);
  for (const [memory, disk] of [['', '😀\n'], ['a\n', ''], ['a\n', 'a'], ['same', 'same'],
    ['x\nx\nx\na\ny\n', 'x\nx\nb\nx\ny\n'], ['😀\n中\n尾', '😀\n国\n尾']] as const) {
    expect(reconstructed(memory, disk).text).toBe(disk);
  }
});

it('reconstructs repeated and reordered lines deterministically without skipping changes', () => {
  let seed = 24;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 200; sample++) {
    const make = () => Array.from({ length: random() % 40 }, () => `${random() % 8}\n`).join('');
    const memory = make(), disk = make();
    expect(reconstructed(memory, disk).text).toBe(disk);
    expect(diffLines(memory, disk)).toEqual(diffLines(memory, disk));
  }
});

it('bounds large or duplicate-only comparisons and labels coarse blocks honestly', () => {
  const memory = 'old\n'.repeat(50_000), disk = 'new\n'.repeat(50_000);
  const result = reconstructed(memory, disk);
  expect(result.text).toBe(disk); expect(result.diff.coarse).toBe(true); expect(result.diff.changes).toHaveLength(1);
  expect(reconstructed('old\n'.repeat(300), 'new\n'.repeat(300)).diff.coarse).toBe(true);
});

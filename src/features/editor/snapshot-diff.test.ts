import { expect, it } from 'vitest';
import { diffSnapshots } from './snapshot-diff';

it('ignores whitespace only for comparison and maps changed blocks back to the exact original line offsets', () => {
  const left = '  same\n\told\n end', right = 'same\n new\nend ';
  const exact = diffSnapshots({ requestId: 'a', left, right, ignoreWhitespace: false });
  expect(exact.changes.length).toBeGreaterThan(0);
  const ignored = diffSnapshots({ requestId: 'b', left, right, ignoreWhitespace: true });
  expect(ignored.changes).toEqual([{ memory: { from: 7, to: 12 }, disk: { from: 5, to: 10 } }]);
  expect(left.slice(ignored.changes[0]!.memory.from, ignored.changes[0]!.memory.to)).toBe('\told\n');
  expect(right.slice(ignored.changes[0]!.disk.from, ignored.changes[0]!.disk.to)).toBe(' new\n');
  expect(diffSnapshots({ requestId: 'c', left: ' a\t', right: 'a', ignoreWhitespace: true }).changes).toEqual([]);
});
it('keeps empty, EOF and coarse blocks bounded against original snapshots', () => {
  for (const [left, right] of [['', ' x'], [' ', 'x\n'], ['a\n', ' a\nb\n'], ['  a', 'b\n']]) {
    const result = diffSnapshots({ requestId: 'job', left: left!, right: right!, ignoreWhitespace: true });
    for (const change of result.changes) {
      expect(change.memory.from).toBeGreaterThanOrEqual(0); expect(change.memory.to).toBeLessThanOrEqual(left!.length);
      expect(change.disk.from).toBeGreaterThanOrEqual(0); expect(change.disk.to).toBeLessThanOrEqual(right!.length);
      expect(change.memory.from).toBeLessThanOrEqual(change.memory.to); expect(change.disk.from).toBeLessThanOrEqual(change.disk.to);
    }
  }
  const left = 'a\n'.repeat(50_001), right = 'b\n'.repeat(50_001);
  const result = diffSnapshots({ requestId: 'large', left, right, ignoreWhitespace: true });
  expect(result.coarse).toBe(true);
  expect(result.changes).toEqual([{ memory: { from: 0, to: left.length }, disk: { from: 0, to: right.length } }]);
});

import { expect, it } from 'vitest';
import { changedLineIndexes, lineRangeLabel } from './replace-preview';

it('marks only lines that differ between the two previews', () => {
  const changes = changedLineIndexes(
    ['first', 'old one', 'third'],
    ['first', 'new one', 'third'],
  );
  expect([...changes.before]).toEqual([1]);
  expect([...changes.after]).toEqual([1]);
});

it('marks an inserted line on the after side without inventing a before change', () => {
  const changes = changedLineIndexes(
    ['first', 'third'],
    ['first', 'second', 'third'],
  );
  expect([...changes.before]).toEqual([]);
  expect([...changes.after]).toEqual([1]);
});

it('marks a removed line on the before side', () => {
  const changes = changedLineIndexes(
    ['first', 'second', 'third'],
    ['first', 'third'],
  );
  expect([...changes.before]).toEqual([1]);
  expect([...changes.after]).toEqual([]);
});

it('keeps identical previews unmarked', () => {
  const changes = changedLineIndexes(['same', 'lines'], ['same', 'lines']);
  expect([...changes.before]).toEqual([]);
  expect([...changes.after]).toEqual([]);
});

it('labels a single line and a line range', () => {
  expect(lineRangeLabel(12, 1)).toBe('第 12 行');
  expect(lineRangeLabel(12, 3)).toBe('第 12–14 行');
});

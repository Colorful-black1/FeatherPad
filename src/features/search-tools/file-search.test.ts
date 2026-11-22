import { expect, it } from 'vitest';
import type { WalkEntry } from '../../bridge/workspace';
import { fuzzyFileMatches } from './file-search';

const entry = (displayName: string, relativePath = displayName): WalkEntry => ({
  ref: { grantId: 'grant', relativePath } as WalkEntry['ref'],
  displayName,
  displayPath: `E:/workspace/${relativePath}`,
  sizeBytes: 10,
  isSymlink: false,
});

it('matches file names case-insensitively and returns highlight positions', () => {
  const result = fuzzyFileMatches([entry('InvoiceReport.sql'), entry('notes.txt')], 'irep');
  expect(result).toHaveLength(1);
  expect(result[0]?.entry.displayName).toBe('InvoiceReport.sql');
  expect(result[0]?.positions).toEqual([0, 7, 8, 9]);
});

it('ranks exact, prefix and contiguous matches ahead of scattered subsequences', () => {
  const result = fuzzyFileMatches([
    entry('x-a-b-c.txt'),
    entry('abc.txt'),
    entry('report-abc.sql'),
    entry('abc'),
  ], 'abc');
  expect(result.map(match => match.entry.displayName)).toEqual(['abc', 'abc.txt', 'report-abc.sql', 'x-a-b-c.txt']);
});

it('does not match characters outside the file name', () => {
  expect(fuzzyFileMatches([entry('invoice.sql', '202611/invoice.sql')], '202611')).toEqual([]);
});

it('rejects a query whose characters are out of order and respects the result limit', () => {
  expect(fuzzyFileMatches([entry('alpha.txt')], 'ahpla')).toEqual([]);
  expect(fuzzyFileMatches([entry('a-1.txt'), entry('a-2.txt'), entry('a-3.txt')], 'a', 2)).toHaveLength(2);
});

import { expect, it } from 'vitest';
import { normalizedFilters, parsePatternLines } from './filters';

it('normalizes visible include/exclude rules and rejects unbounded input', () => {
  expect(parsePatternLines('*.ts\r\n !generated.ts \n*.ts')).toEqual(['*.ts', '!generated.ts']);
  expect(normalizedFilters({ include: [' src/** ', 'src/**'], exclude: ['*.log'],
    respectGitignore: false, followDirectoryLinks: true })).toEqual({
    include: ['src/**'], exclude: ['*.log'], respectGitignore: false, followDirectoryLinks: true,
  });
  expect(() => parsePatternLines('x'.repeat(1025))).toThrow(/1024/);
});

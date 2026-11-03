import { expect, it } from 'vitest';
import { defaultFormatOptions, formatSource, type FormatLanguage, type FormatOptions } from './formatters';

const run = (language: FormatLanguage, source: string, options: Partial<FormatOptions> = {}) =>
  formatSource({ requestId: 'job', documentId: 'fixture', version: 1, language, source, options: { ...defaultFormatOptions, ...options } });
async function output(language: FormatLanguage, source: string, options?: Partial<FormatOptions>) {
  const result = await run(language, source, options);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostic));
  return result.text;
}

it('formats only the selected SQL dialect and preserves comments, literals, identifiers and parameters', async () => {
  for (const dialect of ['sql', 'sqlite', 'postgresql', 'mysql'] as const) {
    const value = await output('sql', "select a,b from t where name='中文' and id = :id; -- 保留\n", { sqlDialect: dialect });
    expect(value).toMatch(/select\s+a,/); expect(value).toContain("'中文'");
    expect(value).toContain('-- 保留'); expect(value).toContain(':id');
  }
  expect(await output('sql', 'select `user-name` from `tbl` limit 2;', { sqlDialect: 'mysql' })).toContain('`user-name`');
  expect(await output('sql', 'select data::jsonb from tbl where id=$1;', { sqlDialect: 'postgresql' })).toContain('$1');
  expect(await run('sql', 'DELIMITER $$ CREATE PROCEDURE p() BEGIN SELECT 1; END $$')).toMatchObject({ ok: false });
  expect(await run('sql', 'select `x` from t;', { sqlDialect: 'sql' })).toMatchObject({ ok: false });
  expect(await output('sql', "select 'CREATE FUNCTION' as value; -- DELIMITER\n")).toContain("'CREATE FUNCTION'");
});

it('keeps YAML comments, order, anchors/aliases, custom tags, multi-documents and scalar chomp', async () => {
  const source = '# 文档\n---\nbase: &base\n   key: value # 随行\nref: *base\nflow: [ 1, 2, 3 ]\ntagged: !local abc\ntext: |-\n  literal\n\n---\nnext: >+\n  folded\n  next\n\n';
  const value = await output('yaml', source, { indent: 4 });
  expect(value).toContain('# 文档'); expect(value).toContain('# 随行');
  expect(value).toContain('&base'); expect(value).toContain('*base'); expect(value).toContain('!local');
  expect(value.match(/^---$/gm)).toHaveLength(2);
  expect(value).toContain('|-'); expect(value).toContain('>+');
  expect(value.indexOf('base:')).toBeLessThan(value.indexOf('ref:'));
  expect(value).toContain('    key:');
});

it('retains numeric literal precision and never expands recursive aliases; refuses invalid or unsafe-to-preserve YAML', async () => {
  expect(await output('yaml', '# comment-only\n')).toBe('# comment-only\n');
  expect(await output('yaml', 'large: 123456789012345678901234567890\nloop: &loop [*loop]\n')).toContain('123456789012345678901234567890');
  expect(await output('yaml', 'loop: &loop [*loop]\n')).toContain('*loop');
  expect(await run('yaml', 'key: [broken\n')).toMatchObject({ ok: false, diagnostic: { line: 2 } });
  expect(await run('yaml', 'key: value\n', { useTabs: true })).toMatchObject({ ok: false, diagnostic: { message: 'YAML缩进只允许空格。' } });
  expect(await run('yaml', 'a: 1\na: 2\n')).toMatchObject({ ok: false });
});

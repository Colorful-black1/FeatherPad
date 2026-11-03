import type { FormatOptions } from './formatters';
import { FormatFailure } from './format-error';
import { sqlDialects, type SqlDialect } from './format-options';

export async function formatSql(source: string, options: FormatOptions & { sqlDialect: SqlDialect }): Promise<string> {
  const sql = await import('sql-formatter');
  const dialects = { sql: sql.sql, sqlite: sql.sqlite, postgresql: sql.postgresql, mysql: sql.mysql };
  if (!sqlDialects.includes(options.sqlDialect)) throw new FormatFailure('不支持此SQL方言。');
  // Conservative refusal for procedural syntax, beyond this formatter's scope.
  // Its local parser never connects to a database or substitutes parameters.
  let backticks = false;
  const structure = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|`(?:``|\\.|[^`])*`|\$([a-z_\d]*)\$[\s\S]*?\$\1\$/gi, match => {
    if (match.startsWith('`')) backticks = true;
    return ' ';
  });
  if (backticks && options.sqlDialect !== 'sqlite' && options.sqlDialect !== 'mysql') throw new FormatFailure('反引号标识符需要显式选择SQLite或MySQL方言。');
  if (/\b(?:DELIMITER|CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER)|LANGUAGE\s+PLPGSQL)\b/i.test(structure)) throw new FormatFailure('不支持存储过程、触发器或自定义分隔符。');
  return sql.formatDialect(source, { dialect: dialects[options.sqlDialect], tabWidth: options.indent, useTabs: options.useTabs,
    keywordCase: 'preserve', dataTypeCase: 'preserve', functionCase: 'preserve', identifierCase: 'preserve',
    paramTypes: { positional: true, named: [':', '@', '$'], numbered: ['?', ':', '$'] },
    linesBetweenQueries: 1, expressionWidth: 80 }) + '\n';
}

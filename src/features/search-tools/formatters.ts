import type { Options, Parser, Plugin } from 'prettier';

export const formatLanguages = ['json', 'jsonc', 'xml', 'html', 'css', 'javascript', 'jsx', 'typescript', 'tsx'] as const;
export type FormatLanguage = typeof formatLanguages[number];
export function formatLanguage(language: string, path: string | null): FormatLanguage | null {
  if (language === 'javascript' && /\.jsx$/i.test(path ?? '')) return 'jsx';
  if (language === 'typescript' && /\.tsx$/i.test(path ?? '')) return 'tsx';
  return formatLanguages.includes(language as FormatLanguage) ? language as FormatLanguage : null;
}
export interface FormatOptions { indent: 2 | 4 | 8; useTabs: boolean; singleQuote: boolean; semi: boolean; trailingComma: 'preserve' | 'none' }
export const defaultFormatOptions: FormatOptions = { indent: 2, useTabs: false, singleQuote: false, semi: true, trailingComma: 'preserve' };
export interface FormatDiagnostic { message: string; line: number; column: number }
export interface FormatRequest { requestId: string; documentId: string; version: number; language: FormatLanguage; options: FormatOptions; source: string }
export type FormatReply = Pick<FormatRequest, 'requestId' | 'documentId' | 'version'> & ({ ok: true; text: string } | { ok: false; diagnostic: FormatDiagnostic });

class FormatFailure extends Error { constructor(message: string, readonly offset = 0) { super(message); } }
function diagnostic(source: string, reason: unknown): FormatDiagnostic {
  if (reason instanceof FormatFailure) {
    const lines = source.slice(0, reason.offset).split('\n');
    return { message: reason.message, line: lines.length, column: lines.at(-1)!.length + 1 };
  }
  let line = 1, column = 1;
  if (reason && typeof reason === 'object') {
    const location: unknown = Reflect.get(reason, 'loc');
    const start: unknown = location && typeof location === 'object' ? Reflect.get(location, 'start') ?? location : undefined;
    if (start && typeof start === 'object') {
      const l: unknown = Reflect.get(start, 'line'), c: unknown = Reflect.get(start, 'column');
      if (typeof l === 'number' && Number.isSafeInteger(l) && l > 0) line = l;
      if (typeof c === 'number' && Number.isSafeInteger(c) && c > 0) column = c;
    }
  }
  // Parser exceptions can contain code frames/user text. Only bounded generic
  // diagnostics cross the worker boundary, with a source location for the UI.
  return { message: '语法无法安全解析，正文未修改。请检查此处及相邻结构。', line, column };
}

function rejectJsx(ast: unknown, mode: 'JSX' | 'TSX') {
  const pending: unknown[] = [ast]; let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (++count > 100_000) throw new FormatFailure('语法节点超过格式化预算。');
    const kind: unknown = Reflect.get(node, 'type');
    if (typeof kind === 'string' && kind.startsWith('JSX')) throw new FormatFailure(`检测到${mode}，请显式选择${mode}模式。`);
    for (const [key, value] of Object.entries(node)) if (!['loc', 'tokens', 'comments', 'extra'].includes(key)) pending.push(value);
  }
}

function withoutJsx(parser: Parser, mode: 'JSX' | 'TSX'): Parser {
  return { ...parser, async parse(text, options) {
    const ast: unknown = await parser.parse(text, options);
    rejectJsx(ast, mode);
    return ast;
  } };
}

async function jsonFormat(source: string, language: 'json' | 'jsonc', options: FormatOptions): Promise<string> {
  const json = await import('jsonc-parser');
  const errors: import('jsonc-parser').ParseError[] = [];
  const tree = json.parseTree(source, errors, { disallowComments: language === 'json', allowTrailingComma: language === 'jsonc' });
  if (!tree || errors.length) throw new FormatFailure('JSON语法无效，严格JSON不接受注释或尾逗号。', errors[0]?.offset ?? 0);
  if (language === 'jsonc' && options.trailingComma === 'none') {
    const scanner = json.createScanner(source, true);
    const removals: import('jsonc-parser').Edit[] = [];
    let comma: number | null = null;
    // jsonc-parser's public const-enum values (pinned 3.3.1); verbatim TS
    // cannot reference its ambient enum at runtime.
    const tokens = { eof: 17, closeObject: 2, closeArray: 4, comma: 5 };
    for (let token = scanner.scan(); token !== tokens.eof; token = scanner.scan()) {
      if (comma !== null && (token === tokens.closeObject || token === tokens.closeArray)) removals.push({ offset: comma, length: 1, content: '' });
      comma = token === tokens.comma ? scanner.getTokenOffset() : null;
    }
    source = json.applyEdits(source, removals);
  }
  return json.applyEdits(source, json.format(source, undefined, { tabSize: options.indent, insertSpaces: !options.useTabs, eol: '\n', insertFinalNewline: true }));
}

function xmlBoundary(source: string) {
  // Skip literal comments/CDATA before checking declarations. The XML parser is
  // lexical only and has no entity/network resolver; DTDs are rejected anyway.
  let offset = 0;
  while (offset < source.length) {
    if (source.startsWith('<!--', offset)) { const end = source.indexOf('-->', offset + 4); if (end < 0) break; offset = end + 3; continue; }
    if (source.startsWith('<![CDATA[', offset)) { const end = source.indexOf(']]>', offset + 9); if (end < 0) break; offset = end + 3; continue; }
    if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source.slice(offset, offset + 20))) throw new FormatFailure('XML不允许DTD或实体声明。', offset);
    if (source[offset] === '&') {
      const entity = /^&([^;\s<]+);/.exec(source.slice(offset));
      if (entity && !/^(?:lt|gt|amp|apos|quot|#\d+|#x[\da-f]+)$/i.test(entity[1]!)) throw new FormatFailure('XML不允许自定义或外部实体。', offset);
    }
    offset++;
  }
}

async function webFormat(source: string, language: Exclude<FormatLanguage, 'json' | 'jsonc'>, options: FormatOptions): Promise<string> {
  const prettier = await import('prettier/standalone');
  const plugins: Plugin[] = [];
  let parser: string = language;
  if (language === 'xml') { xmlBoundary(source); plugins.push((await import('@prettier/plugin-xml')).default); }
  else if (language === 'html') plugins.push(await import('prettier/plugins/html'));
  else if (language === 'css') {
    if (/(?:^|[;{}\n])\s*[$@][\w-]+\s*:|#\{|@(?:mixin|include|extend)\b/.test(source)) throw new FormatFailure('此工具仅支持纯CSS，不支持SCSS/Less预处理语法。');
    plugins.push(await import('prettier/plugins/postcss'));
  } else {
    const babel = await import('prettier/plugins/babel');
    plugins.push(await import('prettier/plugins/estree'));
    if (language === 'javascript' || language === 'jsx') {
      parser = 'babel'; plugins.push(babel);
      if (language === 'javascript') {
        parser = 'featherpad-js';
        plugins.push({ parsers: { 'featherpad-js': withoutJsx(babel.parsers.babel!, 'JSX') } });
      }
    } else {
      const typescript = await import('prettier/plugins/typescript');
      parser = 'typescript'; plugins.push(typescript);
      if (language === 'typescript') {
        parser = 'featherpad-ts';
        plugins.push({ parsers: { 'featherpad-ts': withoutJsx(typescript.parsers.typescript!, 'TSX') } });
      }
    }
  }
  const configuration: Options & { xmlWhitespaceSensitivity: string; xmlQuoteAttributes: string } = {
    parser, plugins, filepath: `input.${language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : language}`,
    tabWidth: options.indent, useTabs: options.useTabs, singleQuote: options.singleQuote, semi: options.semi,
    endOfLine: 'lf', printWidth: 100, trailingComma: options.trailingComma === 'none' ? 'none' : 'all',
    htmlWhitespaceSensitivity: 'strict', embeddedLanguageFormatting: 'off',
    xmlWhitespaceSensitivity: 'strict', xmlQuoteAttributes: 'preserve',
  };
  return prettier.format(source, configuration);
}

export async function formatSource(request: FormatRequest): Promise<FormatReply> {
  const identity = { requestId: request.requestId, documentId: request.documentId, version: request.version };
  try {
    if (new TextEncoder().encode(request.source).byteLength >= 20 * 1024 * 1024) throw new FormatFailure('20MiB及以上文档不能格式化。');
    if (!formatLanguages.includes(request.language)) throw new FormatFailure('当前语言没有格式化器，Java仅提供高亮。');
    const text = request.language === 'json' || request.language === 'jsonc' ? await jsonFormat(request.source, request.language, request.options)
      : await webFormat(request.source, request.language, request.options);
    if (new TextEncoder().encode(text).byteLength >= 20 * 1024 * 1024) throw new FormatFailure('格式化结果超过20MiB预算。');
    return { ...identity, ok: true, text };
  } catch (reason: unknown) { return { ...identity, ok: false, diagnostic: diagnostic(request.source, reason) }; }
}

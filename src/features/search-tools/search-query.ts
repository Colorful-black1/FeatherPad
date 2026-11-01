export const SEARCH_PATTERN_LIMIT = 10_240;
export const SEARCH_MATCH_LIMIT = 10_000;

export interface SearchQuery {
  pattern: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
}

export interface SearchScope {
  from: number;
  to: number;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchQueryError {
  message: string;
  index: number;
}

interface CompiledPattern {
  source: string;
  flags: string;
  captureCount: number;
  captureNames: ReadonlySet<string>;
}

type PatternCompilation =
  | { ok: true; pattern: CompiledPattern }
  | { ok: false; error: SearchQueryError };

export type SearchScanResult =
  | { ok: true; matches: readonly SearchMatch[]; truncated: boolean }
  | { ok: false; error: SearchQueryError };

export interface SearchReplacement {
  from: number;
  to: number;
  insert: string;
}

export type SearchReplacementResult =
  | { ok: true; replacements: readonly SearchReplacement[]; truncated: boolean }
  | { ok: false; error: SearchQueryError };

const wordCharacter = /[\p{L}\p{N}_]/u;
const utf8 = new TextEncoder();

function failure(message: string, index = 0): { ok: false; error: SearchQueryError } {
  return { ok: false, error: { message, index } };
}

function enforcePatternBudget(pattern: string): { ok: false; error: SearchQueryError } | null {
  if (utf8.encode(pattern).byteLength <= SEARCH_PATTERN_LIMIT) return null;
  return failure(`查找模式不能超过 ${SEARCH_PATTERN_LIMIT.toLocaleString('zh-CN')} 字节`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readModePrefix(pattern: string): { pattern: string; flags: string } {
  const mode = /^\(\?([ims]+)\)/.exec(pattern);
  if (!mode) return { pattern, flags: '' };
  const unique = [...new Set(mode[1]!.split(''))].join('');
  return { pattern: pattern.slice(mode[0].length), flags: unique };
}

function normalizeRegex(pattern: string): PatternCompilation {
  const overBudget = enforcePatternBudget(pattern);
  if (overBudget) return overBudget;
  let source = '';
  let depth = 0;
  let inCharacterClass = false;
  let captureCount = 0;
  const captureNames = new Set<string>();
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!;
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) return failure('正则表达式以未完成的转义符结尾', index);
      if (/[1-9]/.test(next) || next === 'k' || next === 'g') {
        return failure('当前安全正则不支持回溯引用', index);
      }
      if (next === 'b' || next === 'B') {
        return failure('当前安全正则没有跨引擎一致的词边界，请使用“整词”选项', index);
      }
      if (next === 'c' || next === '0') {
        return failure('当前安全正则不支持该转义语法', index);
      }
      source += character + next;
      index += 2;
      continue;
    }
    if (inCharacterClass) {
      source += character;
      if (character === ']') inCharacterClass = false;
      index++;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      source += character;
      index++;
      continue;
    }
    if (character === ')') {
      if (depth === 0) return failure('右括号没有对应的左括号', index);
      depth--;
      source += character;
      index++;
      continue;
    }
    if (character !== '(') {
      source += character;
      index++;
      continue;
    }
    if (pattern[index + 1] !== '?') {
      captureCount++;
      depth++;
      source += character;
      index++;
      continue;
    }
    if (pattern.startsWith('(?=', index) || pattern.startsWith('(?!', index)
      || pattern.startsWith('(?<=', index) || pattern.startsWith('(?<!', index)) {
      return failure('当前安全正则不支持前后查找（look-around）', index);
    }
    if (pattern.startsWith('(?:', index)) {
      depth++;
      source += '(?:';
      index += 3;
      continue;
    }
    const rustNamed = pattern.startsWith('(?P<', index);
    const jsNamed = pattern.startsWith('(?<', index);
    if (!rustNamed && !jsNamed) return failure('当前安全正则不支持该分组语法', index);
    const nameStart = index + (rustNamed ? 4 : 3);
    const nameEnd = pattern.indexOf('>', nameStart);
    if (nameEnd < 0) return failure('命名分组缺少右尖括号', nameStart);
    const name = pattern.slice(nameStart, nameEnd);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return failure('捕获组名称只能使用 ASCII 字母、数字和下划线，且不能以数字开头', nameStart);
    }
    if (captureNames.has(name)) return failure(`捕获组名称重复：${name}`, nameStart);
    captureNames.add(name);
    captureCount++;
    depth++;
    source += `(?<${name}>`;
    index = nameEnd + 1;
  }
  if (inCharacterClass) return failure('字符类缺少右方括号', pattern.length);
  if (depth > 0) return failure('左括号没有对应的右括号', pattern.length);
  return { ok: true, pattern: { source, flags: '', captureCount, captureNames } };
}

function compilePattern(query: SearchQuery): PatternCompilation {
  if (!query.isRegex) {
    const overBudget = enforcePatternBudget(query.pattern);
    if (overBudget) return overBudget;
    return {
      ok: true,
      pattern: {
        source: escapeRegExp(query.pattern), flags: query.isCaseSensitive ? 'gu' : 'giu',
        captureCount: 0, captureNames: new Set(),
      },
    };
  }
  const modes = readModePrefix(query.pattern);
  const normalized = normalizeRegex(modes.pattern);
  if (!normalized.ok) return normalized;
  const flagSet = new Set(['g', 'u']);
  if (!query.isCaseSensitive || modes.flags.includes('i')) flagSet.add('i');
  if (modes.flags.includes('m')) flagSet.add('m');
  if (modes.flags.includes('s')) flagSet.add('s');
  const flags = [...flagSet].sort().join('');
  try {
    new RegExp(normalized.pattern.source, flags);
  } catch (error) {
    return failure(error instanceof Error ? error.message : '正则表达式无法编译');
  }
  return {
    ok: true,
    pattern: { ...normalized.pattern, flags },
  };
}

function normalizedScope(scope: SearchScope | null, text: string): SearchScope {
  if (!scope) return { from: 0, to: text.length };
  return {
    from: Math.max(0, Math.min(text.length, Math.min(scope.from, scope.to))),
    to: Math.max(0, Math.min(text.length, Math.max(scope.from, scope.to))),
  };
}

function advanceCodePoint(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function previousCodePoint(text: string, index: number): string | null {
  if (index <= 0) return null;
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1] ?? null;
}

function hasWholeWordBoundary(text: string, from: number, to: number): boolean {
  if (from === to) return false;
  const before = previousCodePoint(text, from);
  const after = text.slice(to, advanceCodePoint(text, to));
  return !(before !== null && wordCharacter.test(before))
    && !(after.length > 0 && wordCharacter.test(after));
}

function scanRegex(
  text: string,
  compiled: CompiledPattern,
  scope: SearchScope,
  wholeWord: boolean,
): SearchScanResult {
  const localText = text.slice(scope.from, scope.to);
  const regex = new RegExp(compiled.source, compiled.flags);
  const matches: SearchMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(localText)) !== null) {
    const from = scope.from + match.index;
    const to = from + match[0].length;
    if (!wholeWord || hasWholeWordBoundary(text, from, to)) {
      matches.push({ from, to });
      if (matches.length > SEARCH_MATCH_LIMIT) {
        matches.pop();
        return { ok: true, matches, truncated: true };
      }
    }
    if (match[0].length === 0) {
      if (regex.lastIndex >= localText.length) break;
      regex.lastIndex = advanceCodePoint(localText, regex.lastIndex);
    }
  }
  return { ok: true, matches, truncated: false };
}

export function findMatches(
  query: SearchQuery,
  text: string,
  scope: SearchScope | null = null,
): SearchScanResult {
  if (query.pattern.length === 0) return { ok: true, matches: [], truncated: false };
  const compiled = compilePattern(query);
  if (!compiled.ok) return compiled;
  return scanRegex(text, compiled.pattern, normalizedScope(scope, text), query.isWholeWord);
}

function decodeReplacementEscapes(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    const next = value[index + 1];
    if (character === '\\' && (next === 'n' || next === 't' || next === '\\')) {
      result += next === 'n' ? '\n' : next === 't' ? '\t' : '\\';
      index++;
    } else result += character;
  }
  return result;
}

function expandCaptureTemplate(
  template: string,
  captures: readonly string[],
  groups: Readonly<Record<string, string | undefined>>,
  compiled: CompiledPattern,
): { ok: true; value: string } | { ok: false; error: SearchQueryError } {
  let result = '';
  for (let index = 0; index < template.length; index++) {
    const character = template[index]!;
    if (character !== '$') {
      result += character;
      continue;
    }
    const next = template[index + 1];
    if (next === '$') {
      result += '$';
      index++;
      continue;
    }
    if (next !== undefined && /[0-9]/.test(next)) {
      let end = index + 1;
      while (end < template.length && /[0-9]/.test(template[end]!)) end++;
      const groupNumber = Number(template.slice(index + 1, end));
      if (groupNumber < 1 || groupNumber > compiled.captureCount) {
        return failure(`替换引用了不存在的捕获组 $${groupNumber}`, index);
      }
      result += captures[groupNumber] ?? '';
      index = end - 1;
      continue;
    }
    if (next === '{') {
      const end = template.indexOf('}', index + 2);
      if (end < 0) return failure('命名捕获组引用缺少右花括号', index);
      const name = template.slice(index + 2, end);
      if (!compiled.captureNames.has(name)) return failure(`替换引用了不存在的命名捕获组 ${name}`, index);
      result += groups[name] ?? '';
      index = end;
      continue;
    }
    result += '$';
  }
  return { ok: true, value: result };
}

function replacementValue(
  query: SearchQuery,
  replacement: string,
  interpretEscapes: boolean,
  compiled: CompiledPattern,
  match: RegExpExecArray,
): { ok: true; value: string } | { ok: false; error: SearchQueryError } {
  const source = interpretEscapes ? decodeReplacementEscapes(replacement) : replacement;
  if (!query.isRegex) return { ok: true, value: source };
  return expandCaptureTemplate(source, match, match.groups ?? {}, compiled);
}

export function buildReplacements(
  query: SearchQuery,
  text: string,
  scope: SearchScope | null,
  replacement: string,
  interpretEscapes: boolean,
): SearchReplacementResult {
  if (query.pattern.length === 0) return { ok: true, replacements: [], truncated: false };
  const compiled = compilePattern(query);
  if (!compiled.ok) return compiled;
  const normalized = normalizedScope(scope, text);
  const localText = text.slice(normalized.from, normalized.to);
  const regex = new RegExp(compiled.pattern.source, compiled.pattern.flags);
  const replacements: SearchReplacement[] = [];
  if (query.isRegex) {
    const source = interpretEscapes ? decodeReplacementEscapes(replacement) : replacement;
    const template = expandCaptureTemplate(source, [], {}, compiled.pattern);
    if (!template.ok) return template;
  }
  let match: RegExpExecArray | null;
  while ((match = regex.exec(localText)) !== null) {
    const from = normalized.from + match.index;
    const to = from + match[0].length;
    if (!query.isWholeWord || hasWholeWordBoundary(text, from, to)) {
      if (replacements.length >= SEARCH_MATCH_LIMIT) {
        return { ok: true, replacements: [], truncated: true };
      }
      const expanded = replacementValue(query, replacement, interpretEscapes, compiled.pattern, match);
      if (!expanded.ok) return expanded;
      replacements.push({ from, to, insert: expanded.value });
    }
    if (match[0].length === 0) {
      if (regex.lastIndex >= localText.length) break;
      regex.lastIndex = advanceCodePoint(localText, regex.lastIndex);
    }
  }
  return { ok: true, replacements, truncated: false };
}

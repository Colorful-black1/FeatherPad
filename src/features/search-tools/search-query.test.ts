import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildReplacements, findMatches, SEARCH_PATTERN_LIMIT, type SearchQuery } from './search-query';

interface SemanticFixture {
  cases: {
    name: string;
    pattern: string;
    text: string;
    isRegex: boolean;
    isCaseSensitive: boolean;
    isWholeWord: boolean;
    scope?: [number, number];
    expected: [number, number][];
  }[];
}

const semanticFixture = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/search-semantics.json', import.meta.url),
  'utf8',
)) as SemanticFixture;

const literal = (pattern: string, overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern, isRegex: false, isCaseSensitive: false, isWholeWord: false, ...overrides,
});

describe('file search query', () => {
  it('finds Unicode text case-insensitively without locale-dependent boundaries', () => {
    expect(findMatches(literal('alpha'), 'Alpha ALPHA alpha')).toEqual({
      ok: true,
      matches: [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }],
      truncated: false,
    });
    expect(findMatches(literal('中文', { isWholeWord: true }), '中文中文 中文')).toEqual({
      ok: true,
      matches: [{ from: 5, to: 7 }],
      truncated: false,
    });
  });

  it('limits search to the selected range', () => {
    expect(findMatches(literal('cat'), 'cat cat cat', { from: 4, to: 7 })).toEqual({
      ok: true, matches: [{ from: 4, to: 7 }], truncated: false,
    });
  });

  it('treats literal mode as text rather than regular-expression syntax', () => {
    expect(findMatches(literal('a.b'), 'a.b axb')).toEqual({
      ok: true, matches: [{ from: 0, to: 3 }], truncated: false,
    });
  });

  it('matches the shared Rust/local-worker semantic fixture', () => {
    for (const fixture of semanticFixture.cases) {
      const result = findMatches({
        pattern: fixture.pattern,
        isRegex: fixture.isRegex,
        isCaseSensitive: fixture.isCaseSensitive,
        isWholeWord: fixture.isWholeWord,
      }, fixture.text, fixture.scope ? { from: fixture.scope[0], to: fixture.scope[1] } : null);
      expect(result.ok, fixture.name).toBe(true);
      if (!result.ok) continue;
      expect(result.matches.map(match => [match.from, match.to]), fixture.name).toEqual(fixture.expected);
    }
  });

  it('enforces the pattern budget by UTF-8 bytes', () => {
    expect(findMatches(literal('中'.repeat(Math.floor(SEARCH_PATTERN_LIMIT / 3))), '')).toMatchObject({ ok: true });
    expect(findMatches(literal('中'.repeat(Math.floor(SEARCH_PATTERN_LIMIT / 3) + 1)), '')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('字节') },
    });
  });

  it('caps oversized result sets and reports truncation accurately', () => {
    const result = findMatches(literal('a'), 'a'.repeat(10_001));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
  });

  it('advances across surrogate pairs for zero-length matches and terminates at EOF', () => {
    const result = findMatches({
      pattern: '(?m)^|$', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, '😀\n文');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(4);
    expect(new Set(result.matches.map(match => match.from)).size).toBe(result.matches.length);
  });

  it('rejects unsupported look-around and backreferences with an inline position', () => {
    const lookaround = findMatches({
      pattern: 'a(?=b)', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, 'ab');
    expect(lookaround).toMatchObject({
      ok: false, error: { index: 1, message: expect.stringContaining('look-around') },
    });
    expect(findMatches({
      pattern: '(a)\\1', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, 'aa')).toMatchObject({
      ok: false, error: { index: 3, message: expect.stringContaining('回溯引用') },
    });
    expect(findMatches({
      pattern: '\\bcat\\b', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, 'cat')).toMatchObject({
      ok: false, error: { index: 0, message: expect.stringContaining('整词') },
    });
  });

  it('expands numbered, named and escaped dollar capture references', () => {
    const result = buildReplacements({
      pattern: '(?P<word>\\p{L}+)-(\\d+)', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, 'rune-42', null, '${word}:$2:$$', false);
    expect(result).toEqual({
      ok: true, truncated: false, replacements: [{ from: 0, to: 7, insert: 'rune:42:$' }],
    });
  });

  it('rejects a missing capture reference even when the query has no match', () => {
    expect(buildReplacements({
      pattern: '(a)', isRegex: true, isCaseSensitive: true, isWholeWord: false,
    }, 'bbb', null, '$2', false)).toMatchObject({
      ok: false, error: { message: expect.stringContaining('$2') },
    });
  });

  it('interprets replacement escapes only when explicitly enabled', () => {
    expect(buildReplacements(literal('x'), 'x', null, '\\n\\t\\\\', true)).toEqual({
      ok: true, truncated: false, replacements: [{ from: 0, to: 1, insert: '\n\t\\' }],
    });
    expect(buildReplacements(literal('x'), 'x', null, '\\n', false)).toEqual({
      ok: true, truncated: false, replacements: [{ from: 0, to: 1, insert: '\\n' }],
    });
  });
});

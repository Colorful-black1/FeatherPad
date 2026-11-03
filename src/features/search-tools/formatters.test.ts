import { expect, it } from 'vitest';
import { defaultFormatOptions, formatSource, formatLanguage, type FormatLanguage, type FormatOptions } from './formatters';

const request = (language: FormatLanguage, source: string, options: Partial<FormatOptions> = {}) =>
  formatSource({ documentId: 'fixture', requestId: 'job', version: 3, source, language, options: { ...defaultFormatOptions, ...options } });
async function formatted(language: FormatLanguage, source: string, options?: Partial<FormatOptions>) {
  const result = await request(language, source, options);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostic));
  return result.text;
}

it('formats JSON token whitespace without changing duplicate keys, numeric precision, order or escaping', async () => {
  const text = await formatted('json', '{"n":123456789012345678901234567890,"same":1,"same":2,"small":1e-9999,"text":"\\u4e2d"}');
  expect(text).toContain('123456789012345678901234567890');
  expect(text).toContain('1e-9999');
  expect(text).toContain('"text": "\\u4e2d"');
  expect(text.match(/"same"/g)).toHaveLength(2);
  expect(text.indexOf('"n"')).toBeLessThan(text.indexOf('"same"'));
  expect(text).toMatch(/\n {2}"n"/);
  expect(text.endsWith('\n')).toBe(true);
});

it('keeps JSONC comments/trailing commas and removes only trailing tokens when explicitly selected', async () => {
  const source = '{// 标题\n"first":1,/* 随行 */"array":[2,3,],}';
  const preserved = await formatted('jsonc', source);
  const removed = await formatted('jsonc', source, { trailingComma: 'none', indent: 4 });
  expect(preserved).toContain('// 标题'); expect(preserved).toContain('/* 随行 */');
  expect(preserved.replace(/\s/g, '')).toContain('[2,3,],}');
  expect(removed.replace(/\s/g, '')).toContain('[2,3]}');
  expect(removed).toContain('/* 随行 */');
  const invalid = await request('json', '{\n"a":1,}');
  expect(invalid).toMatchObject({ ok: false, diagnostic: { line: 2 } });
  expect(await request('json', '{/* forbidden */"a":1}')).toMatchObject({ ok: false });
});

it('preserves XML namespaces, CDATA and meaningful mixed-content whitespace; rejects declarations/entities', async () => {
  const source = '<r xmlns:x="urn:test"><x:a><![CDATA[<raw> & content]]></x:a><p> a <b>b</b>  c </p></r>';
  const output = await formatted('xml', source);
  expect(output).toContain('xmlns:x="urn:test"');
  expect(output).toContain('<![CDATA[<raw> & content]]>');
  expect(output).toContain(' a <b>b</b>  c ');
  expect(await request('xml', '<!DOCTYPE r SYSTEM "file:///secret"><r/>')).toMatchObject({ ok: false });
  expect(await request('xml', '<r>&outside;</r>')).toMatchObject({ ok: false });
  expect(await request('xml', '<r><broken></r>')).toMatchObject({ ok: false });
  expect(await formatted('xml', '<r><![CDATA[<!DOCTYPE harmless>]]></r>')).toContain('<!DOCTYPE harmless>');
});

it('formats HTML/CSS text offline, retaining comments/custom properties and never running document scripts', async () => {
  const html = await formatted('html', '<!doctype html><div><script>globalThis.formatterExecuted=1;</script><img src="https://example.com/x"><span> a </span></div>');
  expect(html).toContain('globalThis.formatterExecuted=1;');
  expect(Reflect.get(globalThis, 'formatterExecuted')).toBeUndefined();
  const css = await formatted('css', '/* 保留 */:root{--tone:green;color:var(--tone)}');
  expect(css).toContain('/* 保留 */'); expect(css).toContain('--tone: green;');
  expect(await request('css', '$tone:red; .x{color:$tone}')).toMatchObject({ ok: false });
  expect(await request('html', '<div><span></div>')).toMatchObject({ ok: false });
});

it('parses JS/TS without execution and requires explicit JSX/TSX modes', async () => {
  const js = await formatted('javascript', 'const x={s:"hello"};globalThis.formatterExecuted=1;', { semi: false, singleQuote: true });
  expect(js).toContain("s: 'hello'"); expect(js).not.toContain(';');
  expect(Reflect.get(globalThis, 'formatterExecuted')).toBeUndefined();
  expect(await request('javascript', 'const x=<View/>;')).toMatchObject({ ok: false });
  expect(await formatted('jsx', 'const x=<View a="b"/>;')).toContain('<View a="b" />');
  expect(await formatted('typescript', 'const x: number=1;')).toContain('const x: number = 1;');
  expect(await formatted('tsx', 'const x: JSX.Element=<View/>;')).toContain('<View />');
  expect(await request('typescript', 'const x: JSX.Element=<View/>;')).toMatchObject({ ok: false });
  expect(await request('javascript', 'const ok=1;\nconst x = ;')).toMatchObject({ ok: false, diagnostic: { line: 2 } });
  expect(formatLanguage('java', 'Program.java')).toBeNull();
  expect(formatLanguage('typescript', 'view.tsx')).toBe('tsx');
});

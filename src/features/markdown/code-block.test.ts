import { expect, it } from 'vitest';
import { highlightCodeBlock } from './code-block';

it('highlights local syntax and escapes executable-looking code, with unknown languages kept as text', async () => {
  const json = await highlightCodeBlock('{"中文": true}', 'json');
  expect(json).toContain('<span class="tok-');
  expect(json.replace(/<[^>]*>/g, '')).toBe('{&quot;中文&quot;: true}');
  expect(await highlightCodeBlock('<script>alert(1)</script>', 'unknown')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(await highlightCodeBlock('<img src=x onerror=alert(1)>', 'html')).not.toContain('<img');
});

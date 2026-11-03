import { describe, expect, it } from 'vitest';
import { renderMarkdown, MAX_RENDER_BYTES } from './parser';

const render = (source: string) => renderMarkdown({ requestId: 'job', documentId: 'document', bufferVersion: 7, source });

describe('Markdown worker rendering', () => {
  it('renders GFM tables, tasks, strike, nesting, quotes, escapes and unknown fenced languages', () => {
    const result = render('# 标题\n\n> 引用\n\n- [x] 完成\n  - 子项\n\n| 列 | 值 |\n| --- | --- |\n| 一 | ~~二~~ |\n\n```unknown\n<img onerror=alert(1)>\n```\n\n\\*原样\\*\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const element of ['<h1>', '<blockquote>', '<table>', '<del>', 'type="checkbox"', '<ul>', '&lt;img', '*原样*']) {
      expect(result.html).toContain(element);
    }
    expect(result).toMatchObject({ requestId: 'job', documentId: 'document', bufferVersion: 7 });
  });

  it('escapes document HTML and never emits live image or navigation URLs', () => {
    const result = render('<script>window.pwned=1</script>\n\n![x](https://example.com/leak)\n\n[恶意](javascript:alert%281%29)\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/<script|<img|href=|src=/);
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.blockedResources).toBe(1);
  });

  it('refuses a complete render at the size and node limits without changing the source', () => {
    expect(render('a'.repeat(MAX_RENDER_BYTES)).ok).toBe(false);
    expect(render('*x* '.repeat(20_000)).ok).toBe(false);
    const source = '# abc\n\n**字节不变**';
    render(source);
    expect(source).toBe('# abc\n\n**字节不变**');
  });
});

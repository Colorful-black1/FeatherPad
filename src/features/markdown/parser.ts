import { Marked } from 'marked';

export interface RenderRequest {
  requestId: string;
  documentId: string;
  bufferVersion: number;
  source: string;
}
export type RenderReply = Pick<RenderRequest, 'requestId' | 'documentId' | 'bufferVersion'> &
  ({ ok: true; html: string; blockedResources: number } | { ok: false; message: string });

export const MAX_RENDER_BYTES = 20 * 1024 * 1024;
export const MAX_LIVE_BYTES = 2 * 1024 * 1024;
export const MAX_RENDER_NODES = 50_000;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[char]!);
}

// The worker never loads URLs or executes document HTML. DOMPurify supplies a
// second boundary in the host before this output enters the isolated frame.
export function renderMarkdown(request: RenderRequest): RenderReply {
  const identity = { requestId: request.requestId, documentId: request.documentId,
    bufferVersion: request.bufferVersion };
  if (new TextEncoder().encode(request.source).byteLength >= MAX_RENDER_BYTES) {
    return { ...identity, ok: false, message: '20MiB及以上文档不提供完整阅读或导出，请缩小内容。' };
  }
  let nodes = 0;
  let blockedResources = 0;
  const parser = new Marked({ gfm: true, async: false, silent: false,
    walkTokens() {
      if (++nodes > MAX_RENDER_NODES) throw new Error('NODE_BUDGET');
    },
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ text }) => {
        blockedResources++;
        return `<span class="blocked-resource">[图片未加载：${escapeHtml(text)}]</span>`;
      },
      link({ tokens }) { return `<span class="pending-link">${this.parser.parseInline(tokens)}</span>`; },
      code: ({ text, lang }) => `<pre><code${lang ? ` class="language-${escapeHtml(lang.split(/\s/)[0]!)}"` : ''}>${escapeHtml(text)}</code></pre>\n`,
    },
  });
  try {
    const html = parser.parse(request.source, { async: false });
    if (html.length > 16 * 1024 * 1024) throw new Error('OUTPUT_BUDGET');
    return { ...identity, ok: true, html, blockedResources };
  } catch {
    return { ...identity, ok: false, message: '内容超过阅读渲染预算或无法解析，请缩小内容后重试。' };
  }
}

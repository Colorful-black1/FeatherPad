import { Marked } from 'marked';
import { markdownTasks, type MarkdownTask } from './task-mapping';

export interface RenderRequest {
  requestId: string;
  documentId: string;
  bufferVersion: number;
  source: string;
}
export type RenderReply = Pick<RenderRequest, 'requestId' | 'documentId' | 'bufferVersion'> &
  ({ ok: true; html: string; blockedResources: number; tasks: MarkdownTask[];
    codeBlocks: { text: string; language: string }[] } | { ok: false; message: string });

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
  const tasks = markdownTasks(request.source);
  const taskTokens = new WeakMap<object, number>();
  const codeBlocks: { text: string; language: string }[] = [];
  let taskIndex = 0;
  const parser = new Marked({ gfm: true, async: false, silent: false,
    walkTokens(token) {
      if (++nodes > MAX_RENDER_NODES) throw new Error('NODE_BUDGET');
      if (token.type === 'list_item' && token.task) {
        const task = tasks[taskIndex];
        const checkbox: unknown = Array.isArray(token.tokens)
          ? token.tokens.find((candidate: { type: string }) => candidate.type === 'checkbox') : undefined;
        if (task && task.checked === token.checked && task.rawLine === token.raw.split('\n')[0]!.trim()
          && checkbox && typeof checkbox === 'object') taskTokens.set(checkbox, taskIndex);
        taskIndex++;
      }
    },
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ text }) => {
        blockedResources++;
        return `<span class="blocked-resource">[图片未加载：${escapeHtml(text)}]</span>`;
      },
      link({ tokens }) { return `<span class="pending-link">${this.parser.parseInline(tokens)}</span>`; },
      checkbox(token) {
        const index = taskTokens.get(token);
        return `<input type="checkbox" disabled ${token.checked ? 'checked ' : ''}${index === undefined ? '' : `data-task-id="${index}"`}> `;
      },
      code: ({ text, lang }) => {
        const index = codeBlocks.length;
        const language = lang?.split(/\s/)[0] ?? '';
        codeBlocks.push({ text, language });
        return `<div class="code-block"><div class="code-caption"><span>${escapeHtml(language || '纯文本')}</span><button type="button" data-copy-id="${index}">复制代码</button></div><pre><code data-code-id="${index}">${escapeHtml(text)}</code></pre></div>\n`;
      },
    },
  });
  try {
    const html = parser.parse(request.source, { async: false });
    if (html.length > 16 * 1024 * 1024) throw new Error('OUTPUT_BUDGET');
    return { ...identity, ok: true, html, blockedResources, tasks, codeBlocks };
  } catch {
    return { ...identity, ok: false, message: '内容超过阅读渲染预算或无法解析，请缩小内容后重试。' };
  }
}

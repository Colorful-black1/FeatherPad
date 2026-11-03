import { Marked, Renderer } from 'marked';
import { markdownTasks, type MarkdownTask } from './task-mapping';
import { headingAnchor, headingLocations, topLevelSourceRanges, type SourceBlock, type MarkdownHeading } from './source-map';

export interface RenderRequest {
  requestId: string;
  documentId: string;
  bufferVersion: number;
  source: string;
  allowHtml?: boolean;
}
export type RenderReply = Pick<RenderRequest, 'requestId' | 'documentId' | 'bufferVersion'> &
  ({ ok: true; html: string; blockedResources: number; tasks: MarkdownTask[];
    images: { url: string; alt: string }[]; links: { url: string }[];
    rawHtml: string[]; htmlWarning?: string;
    headings: MarkdownHeading[]; sourceMap: SourceBlock[]; mappingWarning?: string;
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
  const images: { url: string; alt: string }[] = [];
  const links: { url: string }[] = [];
  const rawHtml: string[] = [];
  const blocks = new Map<number, SourceBlock>();
  const blockTokens = new WeakMap<object, SourceBlock>();
  const locations = headingLocations(request.source);
  const headingTokens = new WeakMap<object, (typeof locations)[number]>();
  const headings: MarkdownHeading[] = [];
  const usedAnchors = new Set<string>();
  let headingIndex = 0;
  let mappingFailed = false;
  const attributes = (token: object) => {
    const range = blockTokens.get(token);
    return range ? ` data-source-from="${range.from}"` : '';
  };
  const mapped = (html: string, token: object) => html.replace(/^(<[a-z\d]+)/, `$1${attributes(token)}`);
  let taskIndex = 0;
  const parser = new Marked({ gfm: true, async: false, silent: false,
    hooks: { processAllTokens(tokens) {
      const ranges = topLevelSourceRanges(request.source, tokens);
      if (!ranges) mappingFailed = true;
      else for (const [index, token] of tokens.entries()) {
        const range = ranges[index];
        if (range) { blockTokens.set(token, range); blocks.set(range.from, range); }
      }
      return tokens;
    } },
    walkTokens(token) {
      if (++nodes > MAX_RENDER_NODES) throw new Error('NODE_BUDGET');
      if (token.type === 'heading') {
        const location = locations[headingIndex++];
        if (location && token.raw.split('\n')[0]!.trim() === location.firstLine) {
          headingTokens.set(token, location); blockTokens.set(token, location); blocks.set(location.from, location);
        } else mappingFailed = true;
      }
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
      html: token => {
        const { text } = token;
        if (!request.allowHtml) return attributes(token) ? `<div${attributes(token)}>${escapeHtml(text)}</div>` : escapeHtml(text);
        const index = rawHtml.length;
        rawHtml.push(text);
        const placeholder = `<span data-raw-html-id="${index}"></span>`;
        return attributes(token) ? `<div${attributes(token)}>${placeholder}</div>` : placeholder;
      },
      heading(token) {
        const text = this.parser.parseInline(token.tokens, this.parser.textRenderer);
        const anchor = headingAnchor(text, usedAnchors);
        const location = headingTokens.get(token);
        if (location) headings.push({ from: location.from, to: location.to, level: token.depth, text, anchor });
        return `<h${token.depth} id="${escapeHtml(anchor)}"${attributes(token)}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      paragraph(token) { return `<p${attributes(token)}>${this.parser.parseInline(token.tokens)}</p>\n`; },
      blockquote(token) { return mapped(Renderer.prototype.blockquote.call(this, token), token); },
      list(token) { return mapped(Renderer.prototype.list.call(this, token), token); },
      table(token) { return mapped(Renderer.prototype.table.call(this, token), token); },
      hr(token) { return mapped(Renderer.prototype.hr.call(this, token), token); },
      image: ({ text, href }) => {
        blockedResources++;
        const index = images.length;
        images.push({ url: href, alt: text });
        return `<span class="blocked-resource" data-image-id="${index}">[图片未加载：${escapeHtml(text)}]</span>`;
      },
      link({ tokens, href }) {
        const index = links.length;
        links.push({ url: href });
        return `<button type="button" class="pending-link" data-link-id="${index}">${this.parser.parseInline(tokens)}</button>`;
      },
      checkbox(token) {
        const index = taskTokens.get(token);
        return `<input type="checkbox" disabled ${token.checked ? 'checked ' : ''}${index === undefined ? '' : `data-task-id="${index}"`}> `;
      },
      code: token => {
        const { text, lang } = token;
        const index = codeBlocks.length;
        const language = lang?.split(/\s/)[0] ?? '';
        codeBlocks.push({ text, language });
        return `<div class="code-block"${attributes(token)}><div class="code-caption"><span>${escapeHtml(language || '纯文本')}</span><button type="button" data-copy-id="${index}">复制代码</button></div><pre><code data-code-id="${index}">${escapeHtml(text)}</code></pre></div>\n`;
      },
    },
  });
  try {
    const html = parser.parse(request.source, { async: false });
    if (html.length > 16 * 1024 * 1024) throw new Error('OUTPUT_BUDGET');
    return { ...identity, ok: true, html, blockedResources, tasks, codeBlocks, images, links, rawHtml, headings,
      sourceMap: [...blocks.values()].sort((a, b) => a.from - b.from),
      ...(mappingFailed ? { mappingWarning: '部分源区间无法可靠映射，同步滚动已暂停。' } : {}) };
  } catch {
    return { ...identity, ok: false, message: '内容超过阅读渲染预算或无法解析，请缩小内容后重试。' };
  }
}

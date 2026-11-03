import DOMPurify from 'dompurify';
import { previewBridge, type ResourceRequest } from '../../bridge/preview';
import { safePreviewUrl } from './links';
import { markdownFrame } from './frame';
import { escapeHtml, type RenderReply, type RenderRequest } from './parser';
import { prepareRawHtml } from './raw-html';
import { safeImageData } from './sanitize';
import type { PreviewImage } from './use-markdown-resources';

export type ReadyMarkdown = Extract<RenderReply, { ok: true }>;
export interface HtmlExport { html: string; failures: { label: string; reason: string }[] }

export function renderExport(request: RenderRequest, signal: AbortSignal): Promise<ReadyMarkdown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/markdown.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string, reply?: ReadyMarkdown) => {
      clearTimeout(timeout); worker.terminate(); signal.removeEventListener('abort', cancel);
      if (reply) resolve(reply); else reject(new Error(error));
    };
    const cancel = () => finish('已取消导出。');
    const timeout = setTimeout(() => finish('导出渲染超过2秒预算，请缩小内容。'), 2000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    worker.onmessage = (event: MessageEvent<RenderReply>) => {
      const reply = event.data;
      if (reply.requestId !== request.requestId || reply.documentId !== request.documentId || reply.bufferVersion !== request.bufferVersion) return;
      if (reply.ok) finish(undefined, prepareRawHtml(reply)); else finish(reply.message);
    };
    worker.onerror = () => finish('无法生成导出快照。');
    worker.postMessage(request);
  });
}

// Reuse the preview's final whitelist and verified image insertion, then remove
// its trusted runtime and replace app controls with inert portable markup.
export function standaloneHtml(reply: ReadyMarkdown, images: ReadonlyMap<number, PreviewImage>, title: string): string {
  const source = new DOMParser().parseFromString(markdownFrame(reply.html, false, 'export', true, images, reply.images), 'text/html');
  const article = source.querySelector('article')!;
  for (const button of article.querySelectorAll('button[data-copy-id]')) button.remove();
  for (const button of article.querySelectorAll('button[data-link-id]')) {
    const index = Number(button.getAttribute('data-link-id'));
    const link = reply.links[index];
    const url = safePreviewUrl(link?.url ?? '', 'link');
    const replacement = source.createElement(url.kind === 'external' || url.kind === 'anchor' ? 'a' : 'span');
    if (replacement instanceof HTMLAnchorElement && (url.kind === 'external' || url.kind === 'anchor')) {
      replacement.setAttribute('href', url.kind === 'anchor' ? `#${url.fragment}` : url.url);
      replacement.setAttribute('rel', 'noreferrer noopener');
    }
    replacement.append(...button.childNodes); button.replaceWith(replacement);
  }
  for (const element of article.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) if (attribute.name.startsWith('data-')) element.removeAttribute(attribute.name);
  }
  const safe = DOMPurify.sanitize(article.innerHTML, { ADD_ATTR: ['disabled'], ALLOW_DATA_ATTR: false });
  const css = source.querySelector('style')!.textContent;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><style>${css}
@media print{body{max-width:none;padding:0}h1,h2,h3,h4,h5,h6{break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{display:table;width:100%;table-layout:fixed}th,td{overflow-wrap:anywhere}img{break-inside:avoid}a{color:inherit}}</style></head><body><article>${safe}</article></body></html>`;
}

export async function prepareHtmlExport(reply: ReadyMarkdown, scope: Pick<ResourceRequest, 'documentId' | 'directory'>,
  title: string, signal: AbortSignal): Promise<HtmlExport> {
  const images = new Map<number, PreviewImage>();
  const failures: HtmlExport['failures'] = [];
  let remaining = 50 * 1024 * 1024;
  for (const [index, image] of reply.images.entries()) {
    signal.throwIfAborted();
    const url = safePreviewUrl(image.url, 'image');
    let reason = '';
    if (index >= 256 || remaining <= 0) reason = '图片数量或总嵌入预算已用完。';
    else if (url.kind !== 'local' && url.kind !== 'data-image') reason = url.kind === 'blocked' ? url.reason : '远程图片保持占位，导出不会联网。';
    else {
      const result = await previewBridge.read({ ...scope, url: url.url, maxBytes: Math.min(20 * 1024 * 1024, remaining) });
      signal.throwIfAborted();
      if (!result.ok) reason = result.error.message;
      else try { images.set(index, safeImageData(result.value)); remaining -= result.value.sizeBytes; }
      catch { reason = '图片清洗或尺寸验证失败。'; }
    }
    if (reason) failures.push({ label: image.alt || `图片${index + 1}`, reason });
  }
  const html = standaloneHtml(reply, images, title);
  if (new TextEncoder().encode(html).byteLength > 64 * 1024 * 1024) throw new Error('导出HTML超过64MiB写入预算，请减少嵌入资源。');
  return { html, failures };
}

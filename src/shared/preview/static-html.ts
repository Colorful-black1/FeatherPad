import DOMPurify from 'dompurify';
import type { PreviewImage } from './resources';

const tags = ['article', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'figure', 'figcaption',
  'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'pre', 'code', 'strong', 'em', 'b', 'i', 's', 'del', 'sub', 'sup', 'kbd', 'details', 'summary', 'a', 'img'];
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export interface StaticHtml { html: string; images: { url: string; alt: string }[] }

export function prepareStaticHtml(source: string): StaticHtml {
  if (new TextEncoder().encode(source).byteLength >= 20 * 1024 * 1024) throw new Error('20MiB及以上HTML不提供完整预览。');
  let count = 0; for (const char of source) if (char === '<' && ++count > 50_000) throw new Error('HTML节点超过50,000预算，请缩小内容。');
  const urls = new WeakMap<Node, string>();
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'src') { urls.set(node, data.attrValue); data.keepAttr = false; }
  });
  const safe = purifier.sanitize(source, { ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['title', 'open', 'colspan', 'rowspan', 'start', 'alt', 'width', 'height'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  const images: StaticHtml['images'] = [];
  for (const image of [...safe.querySelectorAll('img')]) {
    const index = images.length, alt = image.getAttribute('alt') ?? '';
    images.push({ url: urls.get(image) ?? '', alt });
    const placeholder = document.createElement('span'); placeholder.dataset.staticImage = String(index);
    placeholder.textContent = `[图片未加载：${alt}]`; image.replaceWith(placeholder);
  }
  for (const link of [...safe.querySelectorAll('a')]) { const span = document.createElement('span'); span.append(...link.childNodes); link.replaceWith(span); }
  const container = document.createElement('div'); container.append(safe);
  return { html: container.innerHTML, images };
}

export function staticHtmlFrame(snapshot: StaticHtml, images: ReadonlyMap<number, PreviewImage>, dark: boolean): string {
  const accepted = new Set([...images.values()].map(image => image.dataUrl));
  const html = snapshot.html.replace(/<span data-static-image="(\d+)">[\s\S]*?<\/span>/g, (original, raw: string) => {
    const index = Number(raw), image = images.get(index);
    if (!image) return original;
    return `<img src="${image.dataUrl}" alt="${escape(snapshot.images[index]?.alt ?? '')}" width="${image.width}" height="${image.height}">`;
  });
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => { if (data.attrName === 'src' && !accepted.has(data.attrValue)) data.keepAttr = false; });
  const safe = purifier.sanitize(html, { ALLOWED_TAGS: tags.filter(tag => tag !== 'a'),
    ALLOWED_ATTR: ['title', 'open', 'colspan', 'rowspan', 'start', 'src', 'alt', 'width', 'height'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer">
<style>:root{color-scheme:${dark ? 'dark' : 'light'};background:${dark ? '#2c3229' : '#fff'};color:${dark ? '#e0e5d9' : '#292d27'};font:14px/1.8 'Segoe UI','Microsoft YaHei UI',sans-serif}body{padding:24px;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}th,td{border:1px solid #87917c;padding:4px 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:3px solid #87917c;padding-left:16px;margin-left:0}code{font-family:Consolas,monospace}</style></head><body>${safe}</body></html>`;
}

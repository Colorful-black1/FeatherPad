import DOMPurify from 'dompurify';
import { escapeHtml, type RenderReply } from './parser';

const tags = ['p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'pre', 'code', 'strong', 'em', 'b', 'i', 's', 'del', 'sub', 'sup', 'kbd', 'details', 'summary', 'a', 'img'];

// Each raw fragment is cleaned independently before it can meet generated
// task/copy/link controls. User HTML can never supply their reserved metadata.
export function prepareRawHtml(reply: Extract<RenderReply, { ok: true }>): typeof reply {
  if (reply.rawHtml.length === 0) return reply;
  const images = [...reply.images];
  const links = [...reply.links];
  let failed = reply.rawHtml.length > 256;
  const fragments = reply.rawHtml.map(raw => {
    if (reply.rawHtml.length > 256) return escapeHtml(raw);
    try {
      const urls = new WeakMap<Node, string>();
      const purifier = DOMPurify(window);
      purifier.addHook('uponSanitizeAttribute', (node, data) => {
        if (data.attrName === 'src' || data.attrName === 'href') {
          urls.set(node, data.attrValue); data.keepAttr = false;
        }
      });
      const safe = purifier.sanitize(raw, { ALLOWED_TAGS: tags,
        ALLOWED_ATTR: ['class', 'title', 'open', 'colspan', 'rowspan', 'start', 'alt', 'width', 'height', 'aria-label'],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
      for (const image of [...safe.querySelectorAll('img')]) {
        const index = images.length;
        const alt = image.getAttribute('alt') ?? '';
        images.push({ url: urls.get(image) ?? '', alt });
        const placeholder = document.createElement('span');
        placeholder.className = 'blocked-resource';
        placeholder.dataset.imageId = String(index);
        placeholder.textContent = `[图片未加载：${alt}]`;
        image.replaceWith(placeholder);
      }
      for (const link of [...safe.querySelectorAll('a')]) {
        const index = links.length;
        links.push({ url: urls.get(link) ?? '' });
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'pending-link'; button.dataset.linkId = String(index);
        button.append(...link.childNodes);
        link.replaceWith(button);
      }
      const container = document.createElement('div');
      container.append(safe);
      return container.innerHTML;
    } catch {
      failed = true;
      return escapeHtml(raw);
    }
  });
  const html = reply.html.replace(/<span data-raw-html-id="(\d+)"><\/span>/g,
    (_whole, index: string) => fragments[Number(index)] ?? '');
  return { ...reply, html, images, links, ...(failed ? { htmlWarning: '部分HTML超过安全预算或清洗失败，已按纯文本显示。' } : {}) };
}

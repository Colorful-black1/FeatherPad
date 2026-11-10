import DOMPurify from 'dompurify';
import runtimeSource from './preview-runtime.js?raw';
import { escapeHtml } from './parser';
import type { PreviewImage } from './use-markdown-resources';

const tags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code',
  'strong', 'em', 'del', 'a', 'span', 'input', 'button', 'div', 'img', 'b', 'i', 's', 'sub', 'sup', 'kbd',
  'details', 'summary', 'dl', 'dt', 'dd', 'tfoot'];

export function markdownBody(html: string, images: ReadonlyMap<number, PreviewImage>,
  imageLabels: readonly { alt: string }[]): string {
  const accepted = new Set<string>();
  for (const [index, image] of images) {
    accepted.add(image.dataUrl);
    const alt = escapeHtml(imageLabels[index]?.alt ?? '');
    html = html.replace(`<span class="blocked-resource" data-image-id="${index}">[图片未加载：${alt}]</span>`,
      `<img src="${image.dataUrl}" alt="${alt}" width="${image.width}" height="${image.height}">`);
  }
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'src' && !accepted.has(data.attrValue)) data.keepAttr = false;
  });
  return `${purifier.sanitize(html, { ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['id', 'data-source-from', 'class', 'title', 'open', 'colspan', 'rowspan', 'aria-label', 'start', 'align', 'type', 'checked', 'disabled', 'data-task-id', 'data-code-id', 'data-copy-id', 'data-image-id', 'data-link-id', 'src', 'alt', 'width', 'height'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false })}`;
}

export function markdownFrame(html: string, dark: boolean, channel: string, readOnly: boolean,
  images: ReadonlyMap<number, PreviewImage>, imageLabels: readonly { alt: string }[]): string {
  return markdownDocument(markdownBody(html, images, imageLabels), dark, channel, readOnly);
}

export function markdownFrameShell(dark: boolean, channel: string, readOnly: boolean): string {
  return markdownDocument('', dark, channel, readOnly);
}

function markdownDocument(body: string, dark: boolean, channel: string, readOnly: boolean): string {
  const runtime = runtimeSource.replace(/\r\n/g, '\n').trim();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><style>
:root{color-scheme:${dark ? 'dark' : 'light'};font:14px/1.85 'Segoe UI','Microsoft YaHei UI',sans-serif;color:${dark ? '#d4d4d4' : '#292d27'};background:${dark ? '#1e1e1e' : '#fff'}}
*{box-sizing:border-box}body{max-width:760px;margin:0 auto;padding:24px;overflow-wrap:anywhere}
h1{font-size:28px}h2{font-size:19px}h3{font-size:16px}h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.2em 0 .6em}
pre{padding:16px;overflow:auto;background:${dark ? '#252526' : '#eeefe8'};border-radius:4px}
.code-block{position:relative;margin:16px 0;overflow:hidden;border-radius:6px;background:${dark ? '#252526' : '#eeefe8'};--code-copy-hover:${dark ? '#3a3d3f' : '#e0e1d8'}}
.code-block pre{margin:0;padding:34px 16px 16px;background:transparent;border-radius:0}
.code-block-header{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:6px 8px 0 14px;pointer-events:none}
.code-language{color:${dark ? '#9a9a9a' : '#636b5e'};font:11px/1.4 'Cascadia Mono',Consolas,monospace;letter-spacing:.02em;user-select:none}
.code-copy{pointer-events:auto;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:${dark ? '#b5b5b5' : '#62675e'};opacity:0;cursor:pointer;transition:opacity .12s,background-color .12s,color .12s}
.code-block:hover .code-copy,.code-copy:focus-visible{opacity:1}
.code-copy:hover{background:var(--code-copy-hover);color:${dark ? '#e6e6e6' : '#292d27'}}
.code-copy:focus-visible{outline:2px solid ${dark ? '#3794ff' : '#45643b'};outline-offset:-2px}
.code-copy-icon{position:relative;display:block;width:13px;height:13px;--copy-mask:${dark ? '#252526' : '#eeefe8'}}
.code-copy:hover .code-copy-icon{--copy-mask:var(--code-copy-hover)}
.code-copy-icon::before,.code-copy-icon::after{content:'';position:absolute;width:8px;height:9px;border:1.4px solid currentColor;border-radius:1.5px}
.code-copy-icon::before{left:0;top:3px}
.code-copy-icon::after{left:4px;top:0;background:var(--copy-mask)}
.code-copy-check{display:none;width:9px;height:5px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}
.code-copy[data-copied="true"] .code-copy-icon{display:none}
.code-copy[data-copied="true"] .code-copy-check{display:block}
.code-copy[data-copied="true"]{opacity:1;color:${dark ? '#89d185' : '#3f7d3f'}}
@media(hover:none){.code-copy{opacity:.75}}
code{font:13px/1.7 'Cascadia Mono',Consolas,monospace}blockquote{margin-left:0;padding-left:16px;border-left:3px solid ${dark ? '#3794ff' : '#45643b'}}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid ${dark ? '#454545' : '#a3aa99'};padding:4px 12px;text-align:start}
.blocked-resource{display:inline-block;padding:4px 8px;border:1px dashed currentColor;font-size:12px}.pending-link{text-decoration:underline}
img{max-width:100%;height:auto}.pending-link{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0}
input{accent-color:${dark ? '#3794ff' : '#45643b'}}@media(max-width:400px){body{padding:16px}}@media(forced-colors:active){blockquote,th,td{border-color:CanvasText}}
.tok-keyword,.tok-bool,.tok-null{color:${dark ? '#dcdcaa' : '#8a592e'}}.tok-string,.tok-propertyName{color:${dark ? '#ce9178' : '#45643b'}}.tok-number,.tok-typeName{color:${dark ? '#b5cea8' : '#346477'}}.tok-comment{opacity:.75}
</style></head><body data-channel="${channel}" data-read-only="${readOnly}"><article aria-label="Markdown正文">${body}</article><script data-featherpad-runtime nonce="${channel}">${runtime}</script></body></html>`;
}

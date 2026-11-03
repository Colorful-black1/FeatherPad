import DOMPurify from 'dompurify';
import runtimeSource from './preview-runtime.js?raw';

const tags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code',
  'strong', 'em', 'del', 'a', 'span', 'input', 'button', 'div'];

export function markdownFrame(html: string, dark: boolean, channel: string, readOnly: boolean): string {
  const safe = DOMPurify.sanitize(html, { ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['class', 'start', 'align', 'type', 'checked', 'disabled', 'data-task-id', 'data-code-id', 'data-copy-id'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  const runtime = runtimeSource.replace(/\r\n/g, '\n').trim();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><style>
:root{color-scheme:${dark ? 'dark' : 'light'};font:14px/1.85 'Segoe UI','Microsoft YaHei UI',sans-serif;color:${dark ? '#e0e5d9' : '#292d27'};background:${dark ? '#2c3229' : '#fff'}}
*{box-sizing:border-box}body{max-width:760px;margin:0 auto;padding:24px;overflow-wrap:anywhere}
h1{font-size:28px}h2{font-size:19px}h3{font-size:16px}h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.2em 0 .6em}
pre{padding:16px;overflow:auto;background:${dark ? '#20251f' : '#eeefe8'};border-radius:4px}
code{font:13px/1.7 'Cascadia Mono',Consolas,monospace}blockquote{margin-left:0;padding-left:16px;border-left:3px solid ${dark ? '#b0ca98' : '#45643b'}}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid ${dark ? '#78886d' : '#a3aa99'};padding:4px 12px;text-align:start}
.blocked-resource{display:inline-block;padding:4px 8px;border:1px dashed currentColor;font-size:12px}.pending-link{text-decoration:underline}
input{accent-color:#45643b}@media(max-width:400px){body{padding:16px}}@media(forced-colors:active){blockquote,th,td{border-color:CanvasText}}
.code-caption{display:flex;justify-content:space-between;align-items:center;font-size:12px;gap:8px}.code-caption button{font:inherit;cursor:pointer;padding:4px 8px}
.tok-keyword,.tok-bool,.tok-null{color:${dark ? '#d9b78b' : '#8a592e'}}.tok-string,.tok-propertyName{color:${dark ? '#b0ca98' : '#45643b'}}.tok-number,.tok-typeName{color:${dark ? '#a4c8d6' : '#346477'}}.tok-comment{opacity:.75}
</style></head><body data-channel="${channel}" data-read-only="${readOnly}"><article aria-label="Markdown正文">${safe}</article><script data-featherpad-runtime nonce="${channel}">${runtime}</script></body></html>`;
}

export type PreviewUrl =
  | { kind: 'anchor'; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'local'; url: string; path: string; fragment: string }
  | { kind: 'data-image'; url: string; mime: string }
  | { kind: 'blocked'; reason: string };

const blocked = (reason: string): PreviewUrl => ({ kind: 'blocked', reason });
function hasControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code >= 127 && code <= 159) return true;
  }
  return false;
}

export function safePreviewUrl(value: string, purpose: 'link' | 'image'): PreviewUrl {
  if (value.length > 28 * 1024 * 1024 || hasControls(value)) return blocked('链接过长或含控制字符。');
  const raw = value.trim();
  if (!raw) return blocked('资源地址为空。');
  // Decode security-relevant HTML character references before classifying the
  // scheme. The original relative URI remains intact for the native decoder.
  const entityChecked = raw.replace(/&(?:#x([a-f\d]+)|#(\d+)|(colon|Tab|NewLine));?/gi,
    (_match, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      const code = hex ? Number.parseInt(hex, 16) : decimal ? Number.parseInt(decimal, 10)
        : named?.toLowerCase() === 'colon' ? 58 : named?.toLowerCase() === 'tab' ? 9 : 10;
      return code <= 0x10ffff ? String.fromCodePoint(code) : '\0';
    });
  let decoded: string;
  try { decoded = decodeURIComponent(entityChecked); } catch { return blocked('URL编码无效。'); }
  if (hasControls(decoded)) return blocked('链接含控制字符。');
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'data' && purpose === 'image') {
      const mime = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,[a-z\d+/=\s]+$/i.exec(raw)?.[1];
      return mime ? { kind: 'data-image', url: raw, mime: mime.toLowerCase() } : blocked('仅支持受限图片MIME的base64数据地址。');
    }
    if (!['http', 'https', 'mailto'].includes(scheme)) return blocked('已阻止不安全或不支持的协议。');
    try {
      const url = new URL(decoded);
      if (url.username || url.password || (scheme !== 'mailto' && !url.hostname)) return blocked('链接包含凭据或缺少主机。');
      return { kind: 'external', url: url.href };
    } catch { return blocked('链接格式无效。'); }
  }
  if (raw.startsWith('#')) return { kind: 'anchor', fragment: decoded.slice(1) };
  const pathPart = raw.split('#')[0]!.split('?')[0]!;
  let path: string;
  let fragment: string;
  try {
    path = decodeURIComponent(pathPart).replaceAll('\\', '/');
    fragment = decodeURIComponent(raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '');
  } catch { return blocked('URL编码无效。'); }
  if (!path || path.startsWith('/') || path.includes(':') || hasControls(path)) return blocked('绝对路径、网络路径或设备路径不可自动访问。');
  // A second encoding layer is not passed on to any further URL decoder.
  if (/%(?:2e|2f|5c|00|3a)/i.test(path)) return blocked('已阻止重复编码的路径控制字符。');
  return { kind: 'local', url: raw, path, fragment };
}

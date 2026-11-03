import DOMPurify from 'dompurify';
import type { ResourceImage } from '../contracts/files';

const svgTags = ['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath'];
const svgAttributes = ['xmlns', 'id', 'width', 'height', 'viewBox', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'transform', 'opacity', 'offset',
  'stop-color', 'stop-opacity', 'clip-path', 'gradientUnits', 'gradientTransform'];

function svgLength(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)(px|pt|pc|in|cm|mm)?\s*$/.exec(value);
  if (!match) return null;
  const factor: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
  return Number(match[1]) * (factor[match[2] ?? 'px'] ?? 1);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let from = 0; from < bytes.length; from += 16_384) binary += String.fromCharCode(...bytes.subarray(from, from + 16_384));
  return btoa(binary);
}

export function safeImageData(image: ResourceImage): { dataUrl: string; width: number; height: number } {
  if (image.mime !== 'image/svg+xml') return { dataUrl: `data:${image.mime};base64,${image.dataBase64}`,
    width: image.width!, height: image.height! };
  const binary = atob(image.dataBase64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let tags = 0;
  for (const character of source) if (character === '<' && ++tags > 50_000) throw new Error('SVG节点超过安全预算。');
  const cleaned = DOMPurify.sanitize(source, { ALLOWED_TAGS: svgTags, ALLOWED_ATTR: svgAttributes,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  const parsed = new DOMParser().parseFromString(cleaned, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg'
    || parsed.querySelector('parsererror')) throw new Error('SVG不是有效的独立图片。');
  let pathBytes = 0;
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/url\s*\(/i.test(attribute.value)
        && !/^url\(\s*#[a-z][\w:.-]*\s*\)$/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
    pathBytes += element.getAttribute('d')?.length ?? 0;
    pathBytes += element.getAttribute('points')?.length ?? 0;
    if (pathBytes > 1_048_576) throw new Error('SVG路径复杂度超过安全预算。');
  }
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = svgLength(root.getAttribute('width')) ?? (box?.length === 4 ? box[2] : undefined) ?? 300;
  const height = svgLength(root.getAttribute('height')) ?? (box?.length === 4 ? box[3] : undefined) ?? 150;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || width * height > 40_000_000) throw new Error('SVG尺寸超过40MP安全上限。');
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return { dataUrl: `data:image/svg+xml;base64,${toBase64(new XMLSerializer().serializeToString(root))}`, width, height };
}

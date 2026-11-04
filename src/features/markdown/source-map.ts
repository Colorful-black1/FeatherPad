import { GFM, parser } from '@lezer/markdown';

export interface SourceBlock { from: number; to: number }
export interface MarkdownHeading extends SourceBlock { level: number; text: string; anchor: string }
export interface HeadingLocation extends SourceBlock { level: number; firstLine: string }

export function headingLocations(source: string, tree = parser.configure(GFM).parse(source)): HeadingLocation[] {
  const result: HeadingLocation[] = [];
  const cursor = tree.cursor();
  do {
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(cursor.name);
    if (!heading) continue;
    const end = source.indexOf('\n', cursor.from);
    result.push({ from: cursor.from, to: cursor.to, level: Number(heading[1]),
      firstLine: source.slice(cursor.from, end < 0 ? source.length : end).trim() });
  } while (cursor.next());
  return result;
}

export function topLevelSourceRanges(source: string, tokens: readonly { type: string; raw: string }[]): (SourceBlock | null)[] | null {
  let offset = 0;
  const ranges: (SourceBlock | null)[] = [];
  for (const token of tokens) {
    if (!source.startsWith(token.raw, offset)) return null;
    ranges.push(['space', 'def'].includes(token.type) ? null : { from: offset, to: offset + token.raw.length });
    offset += token.raw.length;
  }
  return offset === source.length ? ranges : null;
}

export function headingAnchor(text: string, used: Set<string>): string {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  const base = Array.from(normalized).slice(0, 120).join('') || 'section';
  let anchor = base;
  for (let suffix = 2; used.has(anchor); suffix++) anchor = `${base}-${suffix}`;
  used.add(anchor);
  return anchor;
}

export function blockAtSource(blocks: readonly SourceBlock[], position: number): SourceBlock | null {
  let best: SourceBlock | null = null;
  for (const block of blocks) if (block.from <= position && (!best || block.from > best.from)) best = block;
  return best ?? blocks[0] ?? null;
}

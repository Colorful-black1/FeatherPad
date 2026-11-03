import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, Parser, type Node } from 'yaml';
import type { FormatOptions } from './formatters';
import { FormatFailure } from './format-error';

function fingerprint(source: string): string {
  const docs = parseAllDocuments(source, { keepSourceTokens: true, intAsBigInt: true, strict: true, logLevel: 'silent' });
  const pending: unknown[] = [...new Parser().parse(source)];
  const comments: { offset: number; text: string }[] = [];
  let tokens = 0;
  while (pending.length) {
    const token = pending.pop();
    if (!token || typeof token !== 'object') continue;
    if (++tokens > 100_000) throw new FormatFailure('YAML token预算超限。');
    if (Reflect.get(token, 'type') === 'comment') {
      const raw: unknown = Reflect.get(token, 'source'), offset: unknown = Reflect.get(token, 'offset');
      if (typeof raw === 'string' && typeof offset === 'number') comments.push({ offset, text: raw.trimEnd() });
    }
    pending.push(...Object.values(token));
  }
  let count = 0;
  function node(value: unknown): unknown {
    if (++count > 100_000) throw new FormatFailure('YAML节点预算超限。');
    if (value === null || value === undefined) return null;
    if (isPair(value)) return { key: node(value.key), value: node(value.value) };
    if (!isScalar(value) && !isMap(value) && !isSeq(value) && !isAlias(value)) throw new FormatFailure('无法保真处理YAML节点。');
    const common = { tag: value.tag ?? null, anchor: 'anchor' in value ? value.anchor ?? null : null,
      before: value.commentBefore?.trimEnd() ?? null, comment: value.comment?.trimEnd() ?? null };
    if (isAlias(value)) return { ...common, alias: value.source };
    if (isMap(value)) return { ...common, mapping: value.items.map(node) };
    if (isSeq(value)) return { ...common, sequence: value.items.map(node) };
    const scalar = value as Node & { value: unknown };
    const primitive = scalar.value;
    if (primitive !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof primitive)) throw new FormatFailure('此YAML标量不能保真格式化。');
    const token = value.srcToken;
    const header = token?.type === 'block-scalar'
      ? token.props.filter(part => part.type === 'block-scalar-header').map(part => 'source' in part ? part.source : '') : [];
    const numericRaw = typeof primitive !== 'string' && token && 'source' in token ? token.source : null;
    return { ...common, scalar: typeof primitive === 'number' && Object.is(primitive, -0) ? '-0' : String(primitive),
      type: typeof primitive, numericRaw, header };
  }
  return JSON.stringify({ comments: comments.sort((a, b) => a.offset - b.offset).map(comment => comment.text), docs: docs.map(doc => {
    if (doc.errors.length) {
      const offset = doc.errors[0]!.pos[0];
      throw new FormatFailure('YAML语法无效。', offset);
    }
    return { before: doc.commentBefore?.trimEnd() ?? null, comment: doc.comment?.trimEnd() ?? null,
      version: doc.directives?.yaml, tags: doc.directives?.tags, end: doc.directives?.docEnd,
      contents: node(doc.contents) };
  }) });
}

export async function formatYaml(source: string, options: FormatOptions): Promise<string> {
  if (options.useTabs) throw new FormatFailure('YAML缩进只允许空格。');
  const before = fingerprint(source);
  const prettier = await import('prettier/standalone');
  const yaml = await import('prettier/plugins/yaml');
  // Prettier's source-aware YAML AST printer is checked against original CST
  // metadata and semantic nodes. Never convert to JS objects or expand aliases.
  const output = await prettier.format(source, { parser: 'yaml', plugins: [yaml], tabWidth: options.indent,
    useTabs: false, endOfLine: 'lf', printWidth: 100, proseWrap: 'preserve', embeddedLanguageFormatting: 'off' });
  if (before !== fingerprint(output)) throw new FormatFailure('无法保留YAML注释、锚点、标签、数值或块文本语义，已拒绝应用。');
  return output;
}

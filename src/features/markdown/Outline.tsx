import { useState } from 'react';
import type { MarkdownHeading } from './source-map';

export function Outline({ headings, onGo }: {
  headings: readonly MarkdownHeading[]; onGo: (heading: MarkdownHeading) => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  let hiddenBelow: number | null = null;
  const visible: MarkdownHeading[] = [];
  for (const heading of headings) {
    if (query) { if (heading.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) visible.push(heading); continue; }
    if (hiddenBelow !== null && heading.level > hiddenBelow) continue;
    hiddenBelow = collapsed.has(heading.anchor) ? heading.level : null;
    visible.push(heading);
  }
  return <details className="markdown-outline">
    <summary>目录 · {headings.length}个标题</summary>
    <label>筛选标题 <input aria-label="筛选 Markdown 标题" value={query} onChange={event => setQuery(event.currentTarget.value)} /></label>
    {visible.length === 0 ? <p>没有匹配的标题。</p> : <ol aria-label="Markdown目录">
      {visible.slice(0, 500).map(heading => <li key={heading.anchor} data-level={heading.level}>
        <button type="button" className="plain-button outline-collapse" aria-label={`折叠或展开 ${heading.text || '空标题'}`}
          aria-expanded={!collapsed.has(heading.anchor)} onClick={() => setCollapsed(current => {
            const next = new Set(current); if (next.has(heading.anchor)) next.delete(heading.anchor); else next.add(heading.anchor); return next;
          })}>{collapsed.has(heading.anchor) ? '▸' : '▾'}</button>
        <button type="button" className="plain-button" onClick={() => onGo(heading)}>{heading.text || '空标题'}</button>
      </li>)}
    </ol>}
    {visible.length > 500 && <p>仅展示前500项，请筛选以定位其他标题。</p>}
  </details>;
}

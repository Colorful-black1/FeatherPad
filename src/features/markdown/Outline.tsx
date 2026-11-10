import { useState } from 'react';
import type { MarkdownHeading } from './source-map';

export function Outline({ headings, onGo }: {
  headings: readonly MarkdownHeading[]; onGo: (heading: MarkdownHeading) => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const expandable = new Set<string>();
  for (let index = 0; index < headings.length - 1; index++) {
    const heading = headings[index];
    const next = headings[index + 1];
    if (heading && next && next.level > heading.level) expandable.add(heading.anchor);
  }
  let hiddenBelow: number | null = null;
  const visible: MarkdownHeading[] = [];
  for (const heading of headings) {
    if (query) { if (heading.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) visible.push(heading); continue; }
    if (hiddenBelow !== null && heading.level > hiddenBelow) continue;
    hiddenBelow = collapsed.has(heading.anchor) ? heading.level : null;
    visible.push(heading);
  }
  return <details className="markdown-outline">
    <summary>
      <span className="markdown-outline-title">目录</span>
      <span className="markdown-outline-count">{headings.length}</span>
      <span className="markdown-outline-hint">个标题</span>
    </summary>
    <div className="markdown-outline-body">
      <label className="markdown-outline-search">
        <input aria-label="筛选 Markdown 标题" placeholder="筛选标题…" value={query}
          onChange={event => setQuery(event.currentTarget.value)} />
      </label>
      {visible.length === 0 ? <p className="markdown-outline-empty" role="status">没有匹配的标题。</p>
        : <ol aria-label="Markdown目录">
          {visible.slice(0, 500).map(heading => <li key={heading.anchor} data-level={heading.level}>
            {expandable.has(heading.anchor) ? <button type="button" className="outline-toggle"
              aria-label={`折叠或展开 ${heading.text || '空标题'}`} aria-expanded={!collapsed.has(heading.anchor)}
              onClick={() => setCollapsed(current => {
                const next = new Set(current);
                if (next.has(heading.anchor)) next.delete(heading.anchor);
                else next.add(heading.anchor);
                return next;
              })}>{collapsed.has(heading.anchor) ? '▸' : '▾'}</button>
              : <span className="outline-toggle outline-toggle-empty" aria-hidden="true" />}
            <button type="button" className="outline-link" title={heading.text || '空标题'}
              onClick={() => onGo(heading)}>{heading.text || '空标题'}</button>
          </li>)}
        </ol>}
      {visible.length > 500 && <p className="markdown-outline-empty">仅展示前 500 项，请筛选以定位其他标题。</p>}
    </div>
  </details>;
}

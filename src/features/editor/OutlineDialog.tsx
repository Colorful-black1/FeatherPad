import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { OutlineItem } from './navigation';

export function OutlineDialog({ items, activeOffset = 0, onSelect, onClose }: {
  items: readonly OutlineItem[]; activeOffset?: number;
  onSelect: (item: OutlineItem) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  let currentId: string | null = null;
  for (const item of items) {
    if (item.offset > activeOffset) break;
    currentId = item.id;
  }
  const filtered = query
    ? items.filter(item => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    : items;
  const shown = filtered.slice(0, 500);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    search.current?.focus();
    requestAnimationFrame(() => {
      element?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: 'center' });
    });
    return () => element?.close();
  }, []);
  function navigate(event: KeyboardEvent<HTMLDialogElement>) {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('.outline-row') ?? [])];
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) {
      (event.key === 'ArrowDown' ? buttons[0] : buttons.at(-1))?.focus();
      return;
    }
    if (event.key === 'ArrowUp' && index === 0) { search.current?.focus(); return; }
    const next = event.key === 'ArrowDown'
      ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    buttons[next]?.focus();
  }
  return <dialog ref={dialog} className="outline-dialog" aria-labelledby="outline-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={navigate}>
    <header className="outline-header">
      <div className="outline-titlebar">
        <h2 id="outline-title">文档大纲</h2>
        <span className="outline-count">{items.length}</span>
      </div>
      <button type="button" className="icon-button outline-close" aria-label="关闭大纲" onClick={onClose}>×</button>
    </header>
    <div className="outline-body">
      {items.length > 0 ? <>
        <label className="outline-search">
          <input ref={search} type="search" aria-label="筛选大纲" placeholder="筛选标题…"
            value={query} onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || shown.length === 0) return;
              event.preventDefault();
              const item = shown[0];
              if (!item) return;
              onSelect(item); onClose();
            }} />
        </label>
        {shown.length > 0 ? <ol className="outline-list" aria-label="文档大纲">
          {shown.map(item => <li key={item.id} data-level={item.level} data-current={item.id === currentId}
            style={{ paddingInlineStart: `${(item.level - 1) * 12}px` }}>
            <button type="button" className="outline-row" title={item.label || '空标题'}
              onClick={() => { onSelect(item); onClose(); }}>
              <span className="outline-level" aria-hidden="true">H{item.level}</span>
              <span className="outline-label">{item.label || '空标题'}</span>
            </button>
          </li>)}
        </ol> : <p className="outline-empty" role="status">没有匹配的标题。</p>}
        {filtered.length > 500 && <p className="outline-empty">仅展示前 500 项，请继续筛选。</p>}
      </> : <p className="outline-empty" role="status">当前文档没有可用的大纲项，或该语言暂未提供本地大纲。</p>}
    </div>
    <footer className="outline-footer">↑↓ 移动 · Enter 跳转 · Esc 关闭</footer>
  </dialog>;
}

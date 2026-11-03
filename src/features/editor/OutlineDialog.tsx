import { useEffect, useRef } from 'react';
import type { OutlineItem } from './navigation';

export function OutlineDialog({ items, onSelect, onClose }: {
  items: readonly OutlineItem[]; onSelect: (item: OutlineItem) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="outline-dialog" aria-labelledby="outline-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="outline-title">本地大纲</h2></header>
    <div className="outline-body">
      <p>仅分析当前文档的 Markdown 标题或 JSON 属性，不扫描工程符号，不提供 LSP。</p>
      {items.length > 0 ? <ol aria-label="文档大纲">
        {items.map(item => <li key={item.id} style={{ paddingInlineStart: `${(item.level - 1) * 0.8}rem` }}>
          <button type="button" className="plain-button" onClick={() => { onSelect(item); onClose(); }}>{item.label}</button>
        </li>)}
      </ol> : <p role="status">当前文档没有可用大纲项，或该语言暂未提供本地大纲。</p>}
    </div>
    <footer><button type="button" className="plain-button" onClick={onClose}>关闭</button></footer>
  </dialog>;
}

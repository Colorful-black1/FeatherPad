import { useState, type MouseEvent } from 'react';
import type { Favorite, FavoriteAction } from './favorites';
import { ExplorerContextMenu, type ExplorerMenuTarget } from './ExplorerContextMenu';

export function FavoriteList({ entries, problem, availableGrantIds, busy, canAddFile, canAddRoot, onAddFile, onAddRoot, onOpen, onRepair, onChange, onClear }: {
  entries: readonly Favorite[]; problem: string | null; availableGrantIds: readonly string[]; busy: boolean;
  canAddFile: boolean; canAddRoot: boolean; onAddFile: () => Promise<string | null>; onAddRoot: () => Promise<string | null>;
  onOpen: (entry: Favorite) => Promise<string | null>; onRepair: (entry: Favorite) => Promise<string | null>;
  onChange: (action: FavoriteAction) => Promise<string | null>; onClear: () => Promise<string | null>;
}) {
  const [working, setWorking] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [name, setName] = useState('');
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [menu, setMenu] = useState<{ entry: Favorite; target: ExplorerMenuTarget } | null>(null);
  const disabled = busy || working || problem !== null;
  async function run(action: () => Promise<string | null>, mark?: Favorite) {
    if (disabled) return;
    setWorking(true); setMessage(null);
    try {
      const error = await action(); setMessage(error);
      if (mark) setFailed(previous => { const next = new Set(previous); if (error) next.add(mark.id); else next.delete(mark.id); return next; });
      return error;
    } finally { setWorking(false); }
  }
  function showMenu(entry: Favorite, event: MouseEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest('input')) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ entry, target: { path: entry.ref.relativePath, grantId: entry.ref.grantId, origin: event.currentTarget,
      x: event.type === 'contextmenu' ? event.clientX : bounds.left, y: event.type === 'contextmenu' ? event.clientY : bounds.bottom } });
  }
  return <section className="recent-panel" aria-labelledby="favorites-heading">
    <div className="recent-heading"><h2 id="favorites-heading" className="visually-hidden">收藏</h2><span>{entries.length}/100</span>
      {entries.length > 0 && <button type="button" className="recent-clear" disabled={disabled}
        onClick={() => setConfirmClear(true)}>清空</button>}
    </div>
    <div className="root-actions">
      <button className="plain-button" disabled={disabled || !canAddFile} onClick={() => void run(onAddFile)}>收藏当前文件</button>
      <button className="plain-button" disabled={disabled || !canAddRoot} onClick={() => void run(onAddRoot)}>收藏当前文件夹</button>
    </div>
    {problem && <p className="tree-state tree-error" role="alert">{problem} 原记录已保留，可在设置中导出后修复。</p>}
    {confirmClear && <div className="recent-confirm" role="group" aria-label="确认清空收藏">
      <p>清空全部收藏？文件、文件夹、最近记录和恢复正文都不会改变。</p>
      <button type="button" autoFocus disabled={disabled} onClick={() => setConfirmClear(false)}>取消清空</button>
      <button type="button" disabled={disabled} onClick={() => void run(async () => {
        const error = await onClear(); if (!error) setConfirmClear(false); return error;
      })}>确认清空收藏</button>
    </div>}
    {message && <p className="tree-state tree-error" role="alert">{message}</p>}
    {!entries.length && !problem && <p className="sidebar-empty">收藏独立于最近记录，可按自己的顺序整理。</p>}
    <ul className="recent-list">{entries.map(entry => {
      const missing = !availableGrantIds.includes(entry.ref.grantId) || failed.has(entry.id);
      return <li key={entry.id} className={missing ? 'recent-missing' : ''} onContextMenu={event => showMenu(entry, event)}>
        <button className="recent-open favorite-open" aria-label={entry.name} aria-description={entry.displayPath}
          disabled={disabled || missing} onClick={() => void run(() => onOpen(entry), entry)} title={entry.displayPath}>
          <span className="recent-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={entry.kind === 'file'
            ? 'M6 3h8l4 4v14H6ZM14 3v5h5' : 'M3 7V5h7l2 2h9v13H3ZM3 9h18'} /></svg></span>
          <span className="recent-copy"><span className="recent-title">{entry.name}</span><small title={entry.displayPath}>{missing ? '需要重新选择' : entry.displayPath}</small></span>
        </button>
        {editing === entry.id ? <form className="root-actions" onSubmit={event => {
          event.preventDefault(); void run(async () => { const error = await onChange({ kind: 'rename', id: entry.id, name }); if (!error) setEditing(null); return error; });
        }}><input autoFocus aria-label={`收藏名称 ${entry.name}`} maxLength={128} value={name} onChange={event => setName(event.target.value)} />
          <button className="plain-button" disabled={disabled}>确定</button>
          <button type="button" className="plain-button" disabled={disabled} onClick={() => setEditing(null)}>取消</button></form>
          : <div className="recent-actions favorite-actions">
            {missing && <button disabled={disabled} onClick={() => void run(() => onRepair(entry), entry)}>重新选择</button>}
            <button type="button" className="sidebar-row-action" disabled={disabled} aria-label={`收藏操作 ${entry.name}`} aria-haspopup="menu"
              title="更多操作" onClick={event => showMenu(entry, event)}>⋯</button>
          </div>}
      </li>;
    })}</ul>
    {menu && <ExplorerContextMenu label="收藏操作" target={menu.target} onClose={() => setMenu(null)} sections={[[
      { id: 'rename', title: `重命名收藏 ${menu.entry.name}`, disabledReason: disabled ? '请等待当前操作。' : null,
        run: () => { setEditing(menu.entry.id); setName(menu.entry.name); } },
      { id: 'up', title: `上移收藏 ${menu.entry.name}`, disabledReason: disabled || entries[0]?.id === menu.entry.id ? '当前无法上移。' : null,
        run: () => { void run(() => onChange({ kind: 'move', id: menu.entry.id, delta: -1 })); } },
      { id: 'down', title: `下移收藏 ${menu.entry.name}`, disabledReason: disabled || entries.at(-1)?.id === menu.entry.id ? '当前无法下移。' : null,
        run: () => { void run(() => onChange({ kind: 'move', id: menu.entry.id, delta: 1 })); } },
      { id: 'remove', title: `移除收藏 ${menu.entry.name}`, disabledReason: disabled ? '请等待当前操作。' : null,
        run: () => { void run(() => onChange({ kind: 'remove', id: menu.entry.id })); } },
    ]]} />}
  </section>;
}

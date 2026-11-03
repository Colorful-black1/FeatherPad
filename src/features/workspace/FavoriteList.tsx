import { useState } from 'react';
import type { Favorite, FavoriteAction } from './favorites';

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
  return <section className="recent-panel" aria-labelledby="favorites-heading">
    <div className="recent-heading"><h2 id="favorites-heading" className="sidebar-title">收藏</h2><span>{entries.length}/100</span>
      {entries.length > 0 && <button type="button" className="recent-clear" disabled={disabled}
        onClick={() => setConfirmClear(true)}>清空</button>}
    </div>
    <div className="root-actions">
      <button className="plain-button" disabled={disabled || !canAddFile} onClick={() => void run(onAddFile)}>收藏当前文件</button>
      <button className="plain-button" disabled={disabled || !canAddRoot} onClick={() => void run(onAddRoot)}>收藏当前根</button>
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
    <ul className="recent-list">{entries.map((entry, index) => {
      const missing = !availableGrantIds.includes(entry.ref.grantId) || failed.has(entry.id);
      return <li key={entry.id} className={missing ? 'recent-missing' : ''}>
        <button className="recent-open" disabled={disabled || missing} onClick={() => void run(() => onOpen(entry), entry)} title={entry.displayPath}>
          <span className="recent-label"><span className="recent-title">{entry.name}</span><small>{missing ? '项目缺失或授权失效' : entry.displayPath}</small></span>
        </button>
        {editing === entry.id ? <form className="root-actions" onSubmit={event => {
          event.preventDefault(); void run(async () => { const error = await onChange({ kind: 'rename', id: entry.id, name }); if (!error) setEditing(null); return error; });
        }}><input autoFocus aria-label={`收藏名称 ${entry.name}`} maxLength={128} value={name} onChange={event => setName(event.target.value)} />
          <button className="plain-button" disabled={disabled}>确定</button>
          <button type="button" className="plain-button" disabled={disabled} onClick={() => setEditing(null)}>取消</button></form>
          : <div className="recent-actions">
            {missing && <button disabled={disabled} onClick={() => void run(() => onRepair(entry), entry)}>重新选择</button>}
            <button disabled={disabled} aria-label={`重命名收藏 ${entry.name}`} onClick={() => { setEditing(entry.id); setName(entry.name); }}>命名</button>
            <button disabled={disabled || index === 0} aria-label={`上移收藏 ${entry.name}`} onClick={() => void run(() => onChange({ kind: 'move', id: entry.id, delta: -1 }))}>↑</button>
            <button disabled={disabled || index === entries.length - 1} aria-label={`下移收藏 ${entry.name}`} onClick={() => void run(() => onChange({ kind: 'move', id: entry.id, delta: 1 }))}>↓</button>
            <button disabled={disabled} aria-label={`移除收藏 ${entry.name}`} onClick={() => void run(() => onChange({ kind: 'remove', id: entry.id }))}>移除</button>
          </div>}
      </li>;
    })}</ul>
  </section>;
}

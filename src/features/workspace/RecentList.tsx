import { useMemo, useState } from 'react';
import type { RecentEntry, RecentKind } from './recent';

type RecentFilter = 'all' | RecentKind;

interface RecentListProps {
  entries: readonly RecentEntry[];
  availableGrantIds: readonly string[];
  enabled: boolean;
  busy: boolean;
  onOpen: (entry: RecentEntry) => Promise<string | null>;
  onRepair: (entry: RecentEntry) => Promise<string | null>;
  onRemove: (entry: RecentEntry) => Promise<string | null>;
  onClear: () => Promise<string | null>;
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function EntryIcon({ kind }: { kind: RecentKind }) {
  return kind === 'workspace'
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6ZM14 3v5h5" /></svg>;
}

export function RecentList({
  entries, availableGrantIds, enabled, busy, onOpen, onRepair, onRemove, onClear,
}: RecentListProps) {
  const [filter, setFilter] = useState<RecentFilter>('all');
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const available = useMemo(() => new Set(availableGrantIds), [availableGrantIds]);
  const visible = entries.filter(entry => filter === 'all' || entry.kind === filter);
  const disabled = busy || workingId !== null;

  async function run(id: string | null, action: () => Promise<string | null>, markEntry?: RecentEntry) {
    if (disabled) return;
    setWorkingId(id); setMessage(null);
    try {
      const error = await action();
      if (markEntry) {
        setFailed(current => {
          const next = new Set(current);
          if (error) next.add(markEntry.id); else next.delete(markEntry.id);
          return next;
        });
      }
      if (error) setMessage(error);
    } finally { setWorkingId(null); }
  }

  async function clear() {
    await run(null, async () => {
      const error = await onClear();
      if (!error) setConfirmClear(false);
      return error;
    });
  }

  return <section className="recent-panel" aria-labelledby="recent-heading">
    <div className="recent-heading">
      <h2 id="recent-heading" className="sidebar-title">最近</h2>
      <span>{entries.length}/50</span>
      {entries.length > 0 && <button type="button" className="recent-clear" disabled={disabled}
        onClick={() => setConfirmClear(true)}>清空</button>}
    </div>
    <div className="recent-filters" role="group" aria-label="最近记录类型">
      {([['all', '全部'], ['file', '文件'], ['workspace', '工作区']] as const).map(([kind, label]) =>
        <button key={kind} type="button" aria-pressed={filter === kind} disabled={disabled}
          onClick={() => setFilter(kind)}>{label}</button>)}
    </div>
    {!enabled && <p className="recent-state" role="note">最近记录已关闭；已有条目保留，可单独移除或清空。</p>}
    {confirmClear && <div className="recent-confirm" role="group" aria-label="确认清空最近记录">
      <p>清空全部最近文件和工作区记录？文件本身不会更改。</p>
      <button type="button" autoFocus disabled={disabled} onClick={() => setConfirmClear(false)}>取消清空</button>
      <button type="button" disabled={disabled} onClick={() => void clear()}>确认清空最近记录</button>
    </div>}
    {message && <p className="recent-message" role="alert">{message}</p>}
    {visible.length === 0
      ? <p className="recent-state">{entries.length === 0 ? '打开文件或文件夹后会显示在这里。' : '此分类没有记录。'}</p>
      : <ul className="recent-list" aria-label="最近打开项目">
        {visible.map(entry => {
          const missing = failed.has(entry.id) || !available.has(entry.ref.grantId);
          return <li key={entry.id} data-missing={missing || undefined}>
            <button type="button" className="recent-open" disabled={disabled} title={entry.displayPath}
              aria-label={`${missing ? '重试打开' : '打开'}${entry.title}`}
              data-recent-kind={entry.kind} data-recent-id={entry.id}
              onClick={() => void run(entry.id, () => onOpen(entry), entry)}>
              <span className="recent-icon"><EntryIcon kind={entry.kind} /></span>
              <span className="recent-copy">
                <span className="recent-title">{entry.title}</span>
                <small>{missing ? '项目缺失或授权失效' : entry.displayPath}</small>
              </span>
              <time dateTime={entry.lastOpenedAt}>{timeFormat.format(new Date(entry.lastOpenedAt))}</time>
            </button>
            <div className="recent-actions">
              {missing && <button type="button" disabled={disabled}
                onClick={() => void run(entry.id, () => onRepair(entry), entry)}>重新选择</button>}
              <button type="button" aria-label={`移除最近记录 ${entry.title}`} disabled={disabled}
                onClick={() => void run(entry.id, () => onRemove(entry))}>移除</button>
            </div>
          </li>;
        })}
      </ul>}
  </section>;
}

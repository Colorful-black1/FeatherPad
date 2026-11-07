import type { ReactNode } from 'react';

export type SidebarView = 'explorer' | 'search' | 'recent' | 'favorites' | 'recovery' | 'workspace';

const activities = [
  { id: 'search', title: '搜索', path: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6' },
  { id: 'recent', title: '最近打开', path: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2' },
  { id: 'favorites', title: '收藏', path: 'm12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z' },
] as const;

export function SidebarActivities({ active, onSelect }: { active: SidebarView | null; onSelect: (view: SidebarView) => void }) {
  return <div className="activity-views">
    {activities.map(item => <button key={item.id} type="button" className="icon-button" title={item.title}
      aria-label={`显示${item.title}`} aria-controls={`sidebar-${item.id}`} aria-pressed={active === item.id}
      onClick={() => onSelect(item.id)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path} /></svg>
    </button>)}
  </div>;
}

export function SidebarPanel({ id, title, active, onBack, children }: {
  id: string; title: string; active: boolean; onBack?: () => void; children: ReactNode;
}) {
  return <section id={`sidebar-${id}`} className="sidebar-view" hidden={!active} aria-label={`${title}视图`}>
    <header className="sidebar-view-heading"><h2>{title}</h2>
      {onBack && <button type="button" className="icon-button compact" onClick={onBack} aria-label="返回资源管理器" title="返回资源管理器">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14" /></svg>
      </button>}
    </header>
    <div className="sidebar-view-body">{children}</div>
  </section>;
}

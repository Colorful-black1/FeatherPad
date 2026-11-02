import type { ReactNode } from 'react';

interface ShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  status: ReactNode;
  headerActions?: ReactNode;
  sidebarOpen: boolean;
  dark: boolean;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  sidebarShortcut?: string | undefined;
  themeShortcut?: string | undefined;
}

export function Shell({ children, sidebar, status, headerActions, sidebarOpen, dark, onToggleSidebar, onToggleTheme, sidebarShortcut, themeShortcut }: ShellProps) {
  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <header className="app-heading">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-mark">
          <path d="M5 21 19 3C9 2 3 8 7 16c7 2 13-3 12-13M10 14l6 0M13 10V6" />
        </svg>
        <span>轻羽 <span className="brand-english">FeatherPad</span></span>
        {headerActions && <div className="heading-actions">{headerActions}</div>}
      </header>
      <div className="app-body">
        <nav className="activity-rail" aria-label="视图">
          <button className="icon-button" onClick={onToggleSidebar} aria-label="切换资源管理器" aria-controls="explorer" aria-expanded={sidebarOpen} aria-keyshortcuts={sidebarShortcut} title={`资源管理器${sidebarShortcut ? `（${sidebarShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" /></svg>
          </button>
          <button className="icon-button theme-button" onClick={onToggleTheme} aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} aria-keyshortcuts={themeShortcut} title={`切换主题${themeShortcut ? `（${themeShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" /></svg>
          </button>
        </nav>
        {sidebarOpen && <>
          <button className="sidebar-scrim" aria-label="关闭资源管理器" onClick={onToggleSidebar} />
          <aside id="explorer" className="sidebar" aria-label="资源管理器">{sidebar}</aside>
        </>}
        <main id="editor-area" className="editor-area" aria-label="文档">{children}</main>
      </div>
      <footer className="statusbar" role="status" aria-live="polite">{status}</footer>
    </div>
  );
}

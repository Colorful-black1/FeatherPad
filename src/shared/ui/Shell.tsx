import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { focusRegion, moveRegionFocus, rememberRegionFocus, type FocusMemory } from './focus-navigation';

interface ShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  status: ReactNode;
  headerActions?: ReactNode;
  menus?: ReactNode;
  railActions?: ReactNode;
  sidebarOpen: boolean;
  dark: boolean;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  sidebarShortcut?: string | undefined;
  themeShortcut?: string | undefined;
}

export function Shell({ children, sidebar, status, headerActions, menus, railActions, sidebarOpen, dark, onToggleSidebar, onToggleTheme, sidebarShortcut, themeShortcut }: ShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const memory = useRef<FocusMemory>(new WeakMap());
  const sidebarHadFocus = useRef(false);
  const previousOpen = useRef(sidebarOpen);
  useLayoutEffect(() => {
    const opened = sidebarOpen && !previousOpen.current;
    previousOpen.current = sidebarOpen;
    if (!sidebarOpen && sidebarHadFocus.current && document.activeElement === document.body) sidebarToggle.current?.focus();
    if (opened && window.matchMedia('(max-width: 1099px)').matches) {
      const region = root.current?.querySelector<HTMLElement>('.sidebar');
      if (region) focusRegion(region, memory.current);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey) return;
      const modal = document.querySelector('dialog[open]');
      if (event.key === 'F6') {
        event.preventDefault();
        event.stopPropagation();
        if (!modal && !event.repeat && root.current) moveRegionFocus(root.current, event.shiftKey, memory.current);
      } else if (event.key === 'Escape' && !modal && sidebarOpen
        && window.matchMedia('(max-width: 1099px)').matches && event.target instanceof Element && event.target.closest('.sidebar')) {
        event.preventDefault();
        onToggleSidebar();
        sidebarToggle.current?.focus();
      }
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [sidebarOpen, onToggleSidebar]);

  function closeSidebar() { onToggleSidebar(); sidebarToggle.current?.focus(); }

  return (
    <div ref={root} className="app-shell" data-sidebar-open={sidebarOpen}
      onFocusCapture={event => {
        rememberRegionFocus(event.currentTarget, event.target, memory.current);
        sidebarHadFocus.current = !!event.target.closest('.sidebar');
        if (sidebarOpen && !document.querySelector('dialog[open]') && event.target.closest('.editor-area')
          && window.matchMedia('(max-width: 1099px)').matches) onToggleSidebar();
      }}>
      <p id="shell-keyboard-help" className="visually-hidden">F6移到下一区域，Shift+F6移到上一区域。窄屏资源管理器内按Escape关闭。</p>
      <header className="app-heading">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-mark">
          <path d="M5 21 19 3C9 2 3 8 7 16c7 2 13-3 12-13M10 14l6 0M13 10V6" />
        </svg>
        <span className="brand-name">轻羽 <span className="brand-english">FeatherPad</span></span>
        {menus}
        {headerActions && <div className="heading-actions">{headerActions}</div>}
      </header>
      <div className="app-body">
        <nav className="activity-rail" aria-label="视图" aria-describedby="shell-keyboard-help">
          <button ref={sidebarToggle} className="icon-button" onClick={onToggleSidebar} aria-label="切换资源管理器" aria-controls="explorer" aria-expanded={sidebarOpen} aria-keyshortcuts={sidebarShortcut} title={`资源管理器${sidebarShortcut ? `（${sidebarShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" /></svg>
          </button>
          {railActions}
          <button className="icon-button theme-button" onClick={onToggleTheme} aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} aria-keyshortcuts={themeShortcut} title={`切换主题${themeShortcut ? `（${themeShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" /></svg>
          </button>
        </nav>
        {sidebarOpen && <>
          <button className="sidebar-scrim" aria-label="关闭资源管理器" onClick={closeSidebar} />
          <aside id="explorer" className="sidebar" aria-label="资源管理器">{sidebar}</aside>
        </>}
        <main id="editor-area" className="editor-area" aria-label="文档" aria-describedby="shell-keyboard-help">{children}</main>
      </div>
      <footer className="statusbar" role="status" aria-label="应用状态" aria-live="polite" aria-atomic="false" aria-relevant="text" tabIndex={-1}>{status}</footer>
    </div>
  );
}

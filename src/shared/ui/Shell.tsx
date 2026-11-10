import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { focusRegion, moveRegionFocus, rememberRegionFocus, type FocusMemory } from './focus-navigation';
import { loadSidebarWidth, saveSidebarWidth, sidebarDefaultWidth, sidebarMaxWidth, sidebarMinWidth } from './view-preferences';

interface ShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  status: ReactNode;
  headerActions?: ReactNode;
  windowControls?: ReactNode;
  menus?: ReactNode;
  railActions?: ReactNode;
  sidebarOpen: boolean;
  dark: boolean;
  onToggleSidebar: () => void;
  onSelectExplorer?: () => void;
  explorerSelected?: boolean;
  onToggleTheme: () => void;
  sidebarShortcut?: string | undefined;
  themeShortcut?: string | undefined;
}

export function Shell({ children, sidebar, status, headerActions, windowControls, menus, railActions, sidebarOpen, dark, onToggleSidebar, onSelectExplorer, explorerSelected = true, onToggleTheme, sidebarShortcut, themeShortcut }: ShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const memory = useRef<FocusMemory>(new WeakMap());
  const sidebarHadFocus = useRef(false);
  const previousOpen = useRef(sidebarOpen);
  const [sidebarPreference] = useState(loadSidebarWidth);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarPreference.value);
  const [maximumWidth, setMaximumWidth] = useState(sidebarMaxWidth);
  const [layoutWarning, setLayoutWarning] = useState(sidebarPreference.warning);
  const sidebarElement = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const visibleWidth = Math.min(sidebarWidth, maximumWidth);
  useLayoutEffect(() => {
    const body = root.current?.querySelector<HTMLElement>('.app-body');
    if (!body) return;
    const resize = () => {
      const rail = body.querySelector<HTMLElement>('.activity-rail')?.clientWidth ?? 48;
      const remaining = window.matchMedia('(max-width: 1099px)').matches ? 16 : 360;
      setMaximumWidth(Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, body.clientWidth - rail - remaining)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  function rememberWidth(width: number) {
    setLayoutWarning(saveSidebarWidth(width));
  }
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
      style={{ '--sidebar-width': `${visibleWidth}px` } as CSSProperties}
      onFocusCapture={event => {
        rememberRegionFocus(event.currentTarget, event.target, memory.current);
        sidebarHadFocus.current = !!event.target.closest('.sidebar');
        if (sidebarOpen && !document.querySelector('dialog[open]') && event.target.closest('.editor-area')
          && window.matchMedia('(max-width: 1099px)').matches) onToggleSidebar();
      }}>
      <p id="shell-keyboard-help" className="visually-hidden">F6移到下一区域，Shift+F6移到上一区域。窄屏资源管理器内按Escape关闭。</p>
      <header className="app-heading" data-tauri-drag-region>
        <div className="app-brand" data-tauri-drag-region="deep">
          <img src="/favicon.svg" alt="" aria-hidden="true" className="brand-mark" />
          <span className="brand-name">轻羽 <span className="brand-english">FeatherPad</span></span>
        </div>
        {menus}
        {headerActions && <div className="heading-actions">{headerActions}</div>}
        {windowControls}
      </header>
      <div className="app-body">
        <nav className="activity-rail" aria-label="视图" aria-describedby="shell-keyboard-help">
          <button ref={sidebarToggle} className="icon-button" onClick={onSelectExplorer ?? onToggleSidebar} aria-label="切换资源管理器" aria-controls="explorer" aria-expanded={sidebarOpen && explorerSelected} aria-keyshortcuts={sidebarShortcut} title={`资源管理器${sidebarShortcut ? `（${sidebarShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" /></svg>
          </button>
          {railActions}
          <button className="icon-button theme-button" onClick={onToggleTheme} aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} aria-keyshortcuts={themeShortcut} title={`切换主题${themeShortcut ? `（${themeShortcut}）` : ''}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" /></svg>
          </button>
        </nav>
        {sidebarOpen && <>
          <button className="sidebar-scrim" aria-label="关闭资源管理器" onClick={closeSidebar} />
          <aside ref={sidebarElement} id="explorer" className="sidebar" aria-label="资源管理器">
            <div className="sidebar-content">
              {layoutWarning && <p className="sidebar-empty" role="status">{layoutWarning}</p>}
              {sidebar}
            </div>
            <div className="sidebar-divider" role="separator" tabIndex={0}
              aria-label="调整侧栏宽度" aria-controls="explorer" aria-orientation="vertical"
              aria-valuemin={sidebarMinWidth} aria-valuemax={maximumWidth} aria-valuenow={visibleWidth}
              aria-valuetext={`${visibleWidth} 像素`} title="拖动调整宽度，双击恢复默认；方向键也可调整"
              onDoubleClick={() => { setSidebarWidth(sidebarDefaultWidth); rememberWidth(sidebarDefaultWidth); }}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const width = event.key === 'Home' ? sidebarMinWidth : event.key === 'End' ? maximumWidth
                  : Math.max(sidebarMinWidth, Math.min(maximumWidth, visibleWidth + (event.key === 'ArrowLeft' ? -16 : 16)));
                setSidebarWidth(width); rememberWidth(width);
              }}
              onPointerDown={event => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: visibleWidth, width: visibleWidth };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event => {
                const sidebar = sidebarElement.current;
                if (!sidebar || drag.current?.pointerId !== event.pointerId) return;
                const bounds = sidebar.getBoundingClientRect();
                const scale = bounds.width / sidebar.offsetWidth;
                const width = Math.round(drag.current.startWidth + (event.clientX - drag.current.startX) / scale);
                const next = Math.max(sidebarMinWidth, Math.min(maximumWidth, width));
                drag.current.width = next;
                setSidebarWidth(next);
              }}
              onPointerUp={event => {
                if (drag.current?.pointerId !== event.pointerId) return;
                rememberWidth(drag.current.width);
                drag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                if (drag.current) setSidebarWidth(drag.current.startWidth);
                drag.current = null;
              }}
              onLostPointerCapture={() => {
                if (drag.current) setSidebarWidth(drag.current.startWidth);
                drag.current = null;
              }} />
          </aside>
        </>}
        <main id="editor-area" className="editor-area" aria-label="文档" aria-describedby="shell-keyboard-help">{children}</main>
      </div>
      <footer className="statusbar" role="status" aria-label="应用状态" aria-live="polite" aria-atomic="false" aria-relevant="text" tabIndex={-1}>{status}</footer>
    </div>
  );
}

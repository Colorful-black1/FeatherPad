import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktopRuntime } from '../../bridge/desktop';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const appWindow = getCurrentWindow();
    let active = true;
    const sync = () => {
      void appWindow.isMaximized().then(value => {
        if (active) setMaximized(value);
      }).catch(() => undefined);
    };
    sync();
    let unlisten: (() => void) | null = null;
    void appWindow.onResized(sync).then(stop => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  if (!isDesktopRuntime()) return null;
  const appWindow = getCurrentWindow();
  return <div className="window-controls" role="group" aria-label="窗口控制">
    <button type="button" className="window-control" aria-label="最小化窗口" title="最小化"
      onClick={() => { void appWindow.minimize().catch(() => undefined); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" /></svg>
    </button>
    <button type="button" className="window-control" aria-label={maximized ? '还原窗口' : '最大化窗口'}
      title={maximized ? '还原' : '最大化'} onClick={() => {
        void appWindow.toggleMaximize()
          .then(() => appWindow.isMaximized())
          .then(value => setMaximized(value))
          .catch(() => undefined);
      }}>
      {maximized
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7Z" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx=".5" /></svg>}
    </button>
    <button type="button" className="window-control window-control-close" aria-label="关闭窗口" title="关闭"
      onClick={() => { void appWindow.close().catch(() => undefined); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </button>
  </div>;
}

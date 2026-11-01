import { useEffect, useState } from 'react';
import { Shell } from '../shared/ui/Shell';

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  return (
    <Shell
      sidebarOpen={sidebarOpen}
      dark={dark}
      onToggleSidebar={() => setSidebarOpen(open => !open)}
      onToggleTheme={() => setDark(value => !value)}
      sidebar={<><h2 className="sidebar-title">资源管理器</h2><p className="sidebar-empty">尚未打开文件夹</p></>}
      status={<><span>就绪</span><span className="status-end">轻羽 FeatherPad</span></>}
    >
      <div className="welcome">
        <div className="welcome-content">
          <p className="welcome-eyebrow">轻羽 FEATHERPAD</p>
          <h1>快开文件，专心编辑。</h1>
          <p className="welcome-description">给文字一处安静的地方。</p>
        </div>
      </div>
    </Shell>
  );
}

import { useEffect, useState } from 'react';
import { Shell } from '../shared/ui/Shell';
import { files } from '../bridge/files';
import { ReadOnlyDocument } from '../features/editor/ReadOnlyDocument';
import type { OpenDocument } from '../shared/contracts/files';

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const [currentDocument, setCurrentDocument] = useState<OpenDocument | null>(null);
  const [folderChosen, setFolderChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  async function openFile() {
    setBusy(true);
    setError(null);
    try {
      const selection = await files.chooseFiles();
      if (!selection.ok) { setError(selection.error.message); return; }
      const reference = selection.value.grants[0];
      if (!reference) return;
      const result = await files.open(reference);
      if (!result.ok) { setError(result.error.message); return; }
      setCurrentDocument(result.value);
    } finally { setBusy(false); }
  }

  async function openFolder() {
    setBusy(true);
    setError(null);
    try {
      const result = await files.chooseFolder();
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.grant) { setFolderChosen(true); setSidebarOpen(true); }
    } finally { setBusy(false); }
  }

  return (
    <Shell
      sidebarOpen={sidebarOpen}
      dark={dark}
      onToggleSidebar={() => setSidebarOpen(open => !open)}
      onToggleTheme={() => setDark(value => !value)}
      sidebar={<><h2 className="sidebar-title">资源管理器</h2><p className="sidebar-empty">{folderChosen ? '文件夹已授权' : '尚未打开文件夹'}</p></>}
      status={<><span>{busy ? '正在打开…' : currentDocument ? '只读' : '就绪'}</span><span className="status-end">{currentDocument ? 'UTF-8' : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {currentDocument ? <ReadOnlyDocument document={currentDocument} /> : <div className="welcome">
        <div className="welcome-content">
          <p className="welcome-eyebrow">轻羽 FEATHERPAD</p>
          <h1>快开文件，专心编辑。</h1>
          <p className="welcome-description">给文字一处安静的地方。</p>
          <div className="welcome-actions">
            <button className="primary-button" onClick={() => void openFile()} disabled={busy}>打开文件</button>
            <button className="plain-button" onClick={() => void openFolder()} disabled={busy}>打开文件夹</button>
          </div>
        </div>
      </div>}
    </Shell>
  );
}

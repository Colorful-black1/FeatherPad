import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { Shell } from '../shared/ui/Shell';
import { files } from '../bridge/files';
import { EditorDocument } from '../features/editor/EditorDocument';
import { documents } from '../features/editor/documents';
import { saves } from '../features/editor/save';
import type { DocumentId } from '../shared/contracts/files';

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const snapshot = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const current = snapshot.documents.find(document => document.id === snapshot.activeId);
  const [autoFocus, setAutoFocus] = useState(true);
  const [folderChosen, setFolderChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const openFile = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    try {
      const selection = await files.chooseFiles(true);
      if (!selection.ok) { setError(selection.error.message); return; }
      const failures: string[] = [];
      setAutoFocus(true);
      for (const reference of selection.value.grants) {
        const result = await files.open(reference);
        if (result.ok) documents.openDocument(result.value);
        else failures.push(result.error.message);
      }
      if (failures.length) setError(failures.join('；'));
    } finally { opening.current = false; setBusy(false); }
  }, [setError, setBusy, setAutoFocus]);

  const newFile = useCallback(() => { setAutoFocus(true); documents.createUntitled(); }, [setAutoFocus]);

  const saveCurrent = useCallback(async () => {
    const id = documents.getSnapshot().activeId;
    if (!id) return;
    setError(null);
    setSavingCount(count => count + 1);
    try {
      const result = await saves.save(id);
      if (!result.ok) setError(result.error.message);
    } finally { setSavingCount(count => count - 1); }
  }, [setError, setSavingCount]);

  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); newFile(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openFile(); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrent(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [newFile, openFile, saveCurrent]);

  async function openFolder() {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await files.chooseFolder();
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.grant) { setFolderChosen(true); setSidebarOpen(true); }
    } finally { opening.current = false; setBusy(false); }
  }

  function selectTab(id: DocumentId) { setAutoFocus(false); documents.activate(id); }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = snapshot.documents.length;
    const target = event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    const document = target === null ? undefined : snapshot.documents[target];
    if (!document) return;
    event.preventDefault();
    selectTab(document.id);
    window.document.getElementById(`tab-${document.id}`)?.focus();
  }

  return (
    <Shell
      sidebarOpen={sidebarOpen}
      dark={dark}
      onToggleSidebar={() => setSidebarOpen(open => !open)}
      onToggleTheme={() => setDark(value => !value)}
      sidebar={<><h2 className="sidebar-title">资源管理器</h2><p className="sidebar-empty">{folderChosen ? '文件夹已授权' : '尚未打开文件夹'}</p></>}
      status={<><span>{savingCount > 0 ? '正在保存…' : busy ? '正在打开…' : current ? current.readOnlyReason ? '只读' : current.dirty ? '未保存修改' : current.displayPath ? '未修改' : '未命名' : '就绪'}</span><span className="status-end">{current ? `${current.format.encoding.toUpperCase()}${current.format.bom === 'none' ? '' : ' BOM'} · ${current.format.lineEnding.toUpperCase()}` : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {current && snapshot.activeId ? <>
        <div className="document-toolbar" aria-label="文件操作">
          <button className="plain-button" onClick={newFile} aria-keyshortcuts="Control+n">新建文本</button>
          <button className="plain-button" onClick={() => void openFile()} disabled={busy} aria-keyshortcuts="Control+o">打开文件</button>
          <button className="plain-button" onClick={() => void saveCurrent()} disabled={!!current.readOnlyReason || savingCount > 0} aria-keyshortcuts="Control+s">保存</button>
        </div>
        <div className="document-tabs" role="tablist" aria-label="打开的文档">
          {snapshot.documents.map((document, index) => <button
            key={document.id} id={`tab-${document.id}`} role="tab" aria-selected={document.id === snapshot.activeId}
            aria-controls={document.id === snapshot.activeId ? `panel-${document.id}` : undefined}
            tabIndex={document.id === snapshot.activeId ? 0 : -1} title={document.displayPath ?? document.title}
            onClick={() => selectTab(document.id)} onKeyDown={event => navigateTabs(event, index)}
          ><span>{document.title}</span>{document.dirty && <span className="dirty-marker" aria-label="有未保存修改">●</span>}</button>)}
        </div>
        <EditorDocument key={snapshot.activeId} registry={documents} id={snapshot.activeId} autoFocus={autoFocus} />
      </> : <div className="welcome">
        <div className="welcome-content">
          <p className="welcome-eyebrow">轻羽 FEATHERPAD</p>
          <h1>快开文件，专心编辑。</h1>
          <p className="welcome-description">给文字一处安静的地方。</p>
          <div className="welcome-actions">
            <button className="plain-button" onClick={newFile} aria-keyshortcuts="Control+n">新建文本</button>
            <button className="primary-button" onClick={() => void openFile()} disabled={busy}>打开文件</button>
            <button className="plain-button" onClick={() => void openFolder()} disabled={busy}>打开文件夹</button>
          </div>
        </div>
      </div>}
    </Shell>
  );
}

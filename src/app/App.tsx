import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { Shell } from '../shared/ui/Shell';
import { files } from '../bridge/files';
import { EditorDocument } from '../features/editor/EditorDocument';
import { documents } from '../features/editor/documents';
import { saves } from '../features/editor/save';
import { saveAll } from '../features/editor/save-all';
import { SaveAllResults } from '../features/editor/SaveAllResults';
import { Explorer } from '../features/workspace/Explorer';
import { workspace } from '../features/workspace/store';
import type { DocumentId, FileRef } from '../shared/contracts/files';

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const snapshot = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const batch = useSyncExternalStore(saveAll.subscribe, saveAll.getSnapshot);
  const batchBusy = batch.phase === 'running' || batch.phase === 'cancelling';
  const current = snapshot.documents.find(document => document.id === snapshot.activeId);
  const currentReference = current ? documents.getDocument(current.id)?.source?.ref : undefined;
  const [autoFocus, setAutoFocus] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewCandidates, setPreviewCandidates] = useState<FileRef[]>([]);
  const opening = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const openOne = useCallback(async (reference: FileRef): Promise<string | null> => {
    const result = await files.open(reference);
    if (result.ok) {
      documents.openDocument(result.value);
      return null;
    }
    if (result.error.code === 'TOO_LARGE') {
      setPreviewCandidates(candidates => candidates.some(candidate =>
        candidate.grantId === reference.grantId && candidate.relativePath === reference.relativePath,
      ) ? candidates : [...candidates, reference]);
    }
    return result.error.message;
  }, []);

  const openFile = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    setPreviewCandidates([]);
    try {
      const selection = await files.chooseFiles(true);
      if (!selection.ok) { setError(selection.error.message); return; }
      const failures = selection.value.failures.map(failure => `第 ${failure.selectionIndex + 1} 个所选文件：${failure.error.message}`);
      setAutoFocus(true);
      for (const reference of selection.value.grants) {
        const failure = await openOne(reference);
        if (failure) failures.push(failure);
      }
      if (failures.length) setError(failures.join('；'));
    } finally { opening.current = false; setBusy(false); }
  }, [openOne, setError, setBusy, setAutoFocus]);

  const openTreeFile = useCallback(async (reference: FileRef) => {
    setBusy(true);
    setError(null);
    try {
      const failure = await openOne(reference);
      if (failure) setError(failure);
    } finally { setBusy(false); }
  }, [openOne, setBusy, setError]);

  const openHeadPreview = useCallback(async (reference: FileRef) => {
    setError(null);
    setBusy(true);
    try {
      const result = await files.open(reference, 'head-preview');
      if (result.ok) {
        documents.openDocument(result.value);
        setPreviewCandidates(candidates => candidates.filter(candidate => candidate !== reference));
      } else setError(result.error.message);
    } finally { setBusy(false); }
  }, [setBusy, setError]);

  const newFile = useCallback(() => { setAutoFocus(true); documents.createUntitled(); }, [setAutoFocus]);

  const saveCurrent = useCallback(async () => {
    if (saveAll.getSnapshot().phase === 'running' || saveAll.getSnapshot().phase === 'cancelling') return;
    const id = documents.getSnapshot().activeId;
    if (!id) return;
    setError(null);
    setSavingCount(count => count + 1);
    try {
      const result = await saves.save(id);
      if (!result.ok && result.error.code !== 'CANCELLED') setError(result.error.message);
    } finally { setSavingCount(count => count - 1); }
  }, [setError, setSavingCount]);

  const saveDestination = useCallback(async (intent: 'save-as' | 'copy' = 'save-as') => {
    if (saveAll.getSnapshot().phase === 'running' || saveAll.getSnapshot().phase === 'cancelling') return;
    const id = documents.getSnapshot().activeId;
    if (!id) return;
    setError(null);
    setNotice(null);
    setSavingCount(count => count + 1);
    try {
      const result = await saves.saveAs(id, intent);
      if (!result.ok) { if (result.error.code !== 'CANCELLED') setError(result.error.message); }
      else if (intent === 'copy') setNotice(`副本已保存：${result.value.metadata.displayPath}`);
    } finally { setSavingCount(count => count - 1); }
  }, [setError, setNotice, setSavingCount]);

  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); void saveDestination(); return; }
      if (event.shiftKey) return;
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); newFile(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openFile(); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrent(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [newFile, openFile, saveCurrent, saveDestination]);

  async function openFolder() {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await files.chooseFolder();
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.grant && result.value.displayName) {
        workspace.setRoot({ grant: result.value.grant, displayName: result.value.displayName });
        setSidebarOpen(true);
      }
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
      sidebar={<Explorer currentReference={currentReference} onOpen={reference => void openTreeFile(reference)} />}
      status={<><span>{batchBusy ? '正在全部保存…' : savingCount > 0 ? '正在保存…' : busy ? '正在打开…' : current ? current.readOnlyReason ? '只读' : current.dirty ? '未保存修改' : current.displayPath ? '未修改' : '未命名' : '就绪'}</span><span className="status-end">{current ? `${current.format.encoding.toUpperCase()}${current.format.bom === 'none' ? '' : ' BOM'} · ${current.format.lineEnding.toUpperCase()}` : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {notice && <div className="notice error-notice" aria-live="polite"><span>{notice}</span><button onClick={() => setNotice(null)}>关闭提示</button></div>}
      {previewCandidates.length > 0 && <div className="notice preview-choice" aria-live="polite">
        <span>超过100MiB的文件不会自动加载完整内容。请选择是否只读预览前1MiB。</span>
        <span className="preview-choice-actions">
          {previewCandidates.map((reference, index) => <button key={reference.grantId} className="plain-button" disabled={busy} onClick={() => void openHeadPreview(reference)}>
            预览所选文件 {index + 1} 的前1MiB
          </button>)}
          <button className="plain-button" onClick={() => setPreviewCandidates([])}>取消预览</button>
        </span>
      </div>}
      {current && snapshot.activeId ? <>
        <div className="document-toolbar" aria-label="文件操作">
          <button className="plain-button" onClick={newFile} aria-keyshortcuts="Control+n">新建文本</button>
          <button className="plain-button" onClick={() => void openFile()} disabled={busy} aria-keyshortcuts="Control+o">打开文件</button>
          <button className="plain-button" onClick={() => void openFolder()} disabled={busy}>打开文件夹</button>
          <button className="plain-button" onClick={() => void saveCurrent()} disabled={!!current.readOnlyReason || savingCount > 0 || batchBusy} aria-keyshortcuts="Control+s">保存</button>
          <button id="save-all-button" className="plain-button" onClick={() => void saveAll.run()} disabled={savingCount > 0 || batchBusy || !snapshot.documents.some(document => document.dirty)}>全部保存</button>
          <button className="plain-button" onClick={() => void saveDestination()} disabled={!current.canSaveAs || savingCount > 0 || batchBusy} aria-keyshortcuts="Control+Shift+s">另存为</button>
          <button className="plain-button" onClick={() => void saveDestination('copy')} disabled={!current.canSaveAs || savingCount > 0 || batchBusy}>保存副本</button>
        </div>
        <SaveAllResults />
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

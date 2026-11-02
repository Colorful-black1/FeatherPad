import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Shell } from '../shared/ui/Shell';
import { CommandPalette } from '../shared/ui/CommandPalette';
import { files } from '../bridge/files';
import { EditorDocument } from '../features/editor/EditorDocument';
import { EditorStatus } from '../features/editor/EditorStatus';
import { languageLabel, languageOptions, type LanguageId } from '../features/editor/editor-language';
import { documents } from '../features/editor/documents';
import { tabs } from '../features/editor/tabs';
import { TabStrip } from '../features/editor/TabStrip';
import { CloseDialog, type CloseTarget } from '../features/editor/CloseDialog';
import { saves } from '../features/editor/save';
import { saveAll } from '../features/editor/save-all';
import { SaveAllResults } from '../features/editor/SaveAllResults';
import { FindBar } from '../features/search-tools/FindBar';
import type { SearchScope } from '../features/search-tools/search-query';
import { Explorer } from '../features/workspace/Explorer';
import { TrashDialog } from '../features/workspace/TrashDialog';
import { workspace } from '../features/workspace/store';
import type { DirectoryEntry, DocumentId, FileRef } from '../shared/contracts/files';
import { ariaShortcut } from '../shared/commands/keyboard';
import { createAppCommands, type AppCommandActions, type AppCommandState, type AppCommandId } from './register-commands';
import { quickCandidates } from './quick-candidates';

interface FindRequest {
  token: number;
  id: DocumentId;
  version: number;
  scope: SearchScope | null;
}

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const snapshot = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const tabState = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
  const batch = useSyncExternalStore(saveAll.subscribe, saveAll.getSnapshot);
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const batchBusy = batch.phase === 'running' || batch.phase === 'cancelling';
  const current = snapshot.documents.find(document => document.id === snapshot.activeId);
  const currentReference = current ? documents.getDocument(current.id)?.source?.ref : undefined;
  const [autoFocus, setAutoFocus] = useState(true);
  const [openingCount, setOpeningCount] = useState(0);
  const busy = openingCount > 0;
  const setBusy = useCallback((active: boolean) => { setOpeningCount(count => count + (active ? 1 : -1)); }, []);
  const [closingCount, setClosingCount] = useState(0);
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null);
  const closeOrigin = useRef<HTMLElement | null>(null);
  const closingIds = useRef(new Set<DocumentId>());
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);
  const [previewCandidates, setPreviewCandidates] = useState<FileRef[]>([]);
  const [trashEntry, setTrashEntry] = useState<DirectoryEntry | null>(null);
  const opening = useRef(false);
  const [commands] = useState(createAppCommands);
  const commandState = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const paletteOrigin = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const openOne = useCallback(async (reference: FileRef, intent: 'preview' | 'pinned' = 'pinned'): Promise<string | null> => {
    const result = await tabs.open(reference, intent);
    if (result.ok) {
      if (result.value.warning && result.value.warning !== tabs.getSnapshot().warning) setNotice(result.value.warning);
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

  const openTreeFile = useCallback(async (reference: FileRef, intent: 'preview' | 'pinned') => {
    setAutoFocus(true);
    setBusy(true);
    setError(null);
    try {
      const failure = await openOne(reference, intent);
      if (failure) setError(failure);
    } finally { setBusy(false); }
  }, [openOne, setBusy, setError]);

  const openHeadPreview = useCallback(async (reference: FileRef) => {
    setError(null);
    setBusy(true);
    try {
      const result = await tabs.open(reference, 'pinned', 'head-preview');
      if (result.ok) {
        setPreviewCandidates(candidates => candidates.filter(candidate => candidate !== reference));
      } else setError(result.error.message);
    } finally { setBusy(false); }
  }, [setBusy, setError]);

  const newFile = useCallback(async () => { setAutoFocus(true); await tabs.createUntitled(); }, [setAutoFocus]);

  const focusAfterClose = useCallback(() => {
    setAutoFocus(true);
    requestAnimationFrame(() => {
      const id = documents.getSnapshot().activeId;
      if (id) { if (!documents.focus(id)) window.document.getElementById(`panel-${id}`)?.focus(); }
      else window.document.querySelector<HTMLButtonElement>('.welcome-actions button')?.focus();
    });
  }, []);

  const requestClose = useCallback(async (id: DocumentId) => {
    if (batchBusy || closingIds.current.has(id)) return;
    const document = documents.getDocument(id);
    if (!document) return;
    setAutoFocus(false);
    if (document.summary.dirty) {
      closeOrigin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
      setCloseTarget({ id, version: document.summary.version });
      return;
    }
    closingIds.current.add(id);
    setClosingCount(count => count + 1);
    try {
      const result = await tabs.close(id, document.summary.version, 'clean');
      if (!result.ok) setError(result.error.message);
      else if (result.value.closed) focusAfterClose();
    } finally { closingIds.current.delete(id); setClosingCount(count => count - 1); }
  }, [batchBusy, focusAfterClose]);

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

  const openFind = useCallback(() => {
    const activeId = documents.getSnapshot().activeId;
    const document = activeId ? documents.getDocument(activeId) : undefined;
    if (!activeId || !document) return;
    const selection = document.state.selection.main;
    setFindRequest(previous => ({
      token: (previous?.token ?? 0) + 1,
      id: activeId,
      version: document.summary.version,
      scope: selection.empty ? null : { from: selection.from, to: selection.to },
    }));
    setFindOpen(true);
  }, []);

  const openFolder = useCallback(async () => {
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
  }, [setBusy]);

  const getCommandState = useCallback((targetId?: DocumentId): AppCommandState => {
    const snapshot = documents.getSnapshot();
    const id = targetId ?? snapshot.activeId;
    const active = id ? documents.getDocument(id)?.summary : undefined;
    const batch = saveAll.getSnapshot();
    return { hasDocument: !!active, readOnlyReason: active?.readOnlyReason ?? null, canSaveAs: active?.canSaveAs ?? false,
      hasDirty: snapshot.documents.some(document => document.dirty), isPreview: !!active && tabs.getSnapshot().previewId === active.id,
      opening: busy, saving: savingCount > 0, closing: closingCount > 0 || !!active?.closing,
      batchBusy: batch.phase === 'running' || batch.phase === 'cancelling' };
  }, [busy, savingCount, closingCount]);
  const commandAvailability: AppCommandState = {
    hasDocument: !!current, readOnlyReason: current?.readOnlyReason ?? null, canSaveAs: current?.canSaveAs ?? false,
    hasDirty: snapshot.documents.some(document => document.dirty), isPreview: !!current && tabState.previewId === current.id,
    opening: busy, saving: savingCount > 0, closing: closingCount > 0 || !!current?.closing, batchBusy,
  };
  const openPalette = useCallback((mode: 'commands' | 'files') => {
    paletteOrigin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    setAutoFocus(false);
    setPaletteMode(mode);
  }, []);
  const restorePaletteFocus = useCallback(() => {
    if (paletteOrigin.current?.isConnected) paletteOrigin.current.focus();
    else { const id = documents.getSnapshot().activeId; if (id) documents.focus(id); }
  }, []);
  const commandActions = useMemo<AppCommandActions>(() => ({
    'file.new': newFile, 'file.open': openFile, 'workspace.open': openFolder, 'file.save': saveCurrent,
    'file.saveAs': () => saveDestination(), 'file.saveCopy': () => saveDestination('copy'),
    'file.saveAll': async () => { await saveAll.run(); },
    'file.close': async () => { const id = documents.getSnapshot().activeId; if (id) await requestClose(id); },
    'editor.find': openFind, 'tabs.pin': () => { const id = documents.getSnapshot().activeId; if (id) tabs.pin(id); },
    'view.sidebar': () => setSidebarOpen(open => !open), 'view.theme': () => setDark(value => !value),
    'commands.open': () => openPalette('commands'), 'files.quickOpen': () => openPalette('files'),
  }), [newFile, openFile, openFolder, saveCurrent, saveDestination, requestClose, openFind, openPalette]);

  const executeCommand = useCallback(async (id: string, targetId?: DocumentId) => {
    const actions = targetId ? { ...commandActions, 'file.close': () => requestClose(targetId), 'tabs.pin': () => tabs.pin(targetId) } : commandActions;
    const result = await commands.execute(id, getCommandState(targetId), actions);
    if (!result.ok) setError(result.reason);
  }, [commands, getCommandState, commandActions, requestClose]);

  const quickFiles = useMemo(() => paletteMode === 'files' ? quickCandidates(snapshot.documents.map(document => ({
    id: document.id, title: document.title, displayPath: document.displayPath, ref: documents.getDocument(document.id)?.source?.ref ?? null,
  })), workspaceState) : null, [paletteMode, snapshot.documents, workspaceState]);

  function commandProps(id: AppCommandId) {
    const reason = commands.disabledReason(id, commandAvailability);
    return { disabled: reason !== null,
      'aria-keyshortcuts': ariaShortcut(commands.binding(id)), title: reason ?? commands.binding(id) ?? undefined };
  }

  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.keyCode === 229) return;
      const id = commands.commandForEvent(event);
      if (!id) return;
      event.preventDefault();
      if (event.repeat || window.document.querySelector('dialog[open]')) return;
      void executeCommand(id);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [commands, executeCommand]);

  function selectTab(id: DocumentId) { setAutoFocus(false); documents.activate(id); }

  return (
    <Shell
      sidebarOpen={sidebarOpen}
      dark={dark}
      headerActions={<>
        <button type="button" className="plain-button" {...commandProps('files.quickOpen')}
          onClick={() => void executeCommand('files.quickOpen')}>快速打开 <kbd>{commands.binding('files.quickOpen') ?? ''}</kbd></button>
        <button type="button" className="plain-button" {...commandProps('commands.open')}
          onClick={() => void executeCommand('commands.open')}>命令面板 <kbd>{commands.binding('commands.open') ?? ''}</kbd></button>
      </>}
      onToggleSidebar={() => void executeCommand('view.sidebar')}
      onToggleTheme={() => void executeCommand('view.theme')}
      sidebarShortcut={ariaShortcut(commands.binding('view.sidebar'))}
      themeShortcut={ariaShortcut(commands.binding('view.theme'))}
      sidebar={<Explorer currentReference={currentReference} onOpen={(reference, intent) => void openTreeFile(reference, intent ?? 'preview')}
        onTrash={setTrashEntry} mutationBlocked={busy || savingCount > 0 || batchBusy || closingCount > 0}
        onRenamed={renamed => documents.applyRenamedPaths(renamed)} />}
      status={<><span>{closingCount > 0 || current?.closing ? '正在关闭…' : batchBusy ? '正在全部保存…' : savingCount > 0 ? '正在保存…' : busy ? '正在打开…' : current ? current.readOnlyReason ? '只读' : current.dirty ? '未保存修改' : current.displayPath ? '未修改' : '未命名' : '就绪'}</span>{current && <EditorStatus registry={documents} id={current.id} summary={current} />}<span className="status-end">{current ? `${current.format.encoding.toUpperCase()}${current.format.bom === 'none' ? '' : ' BOM'} · ${current.format.lineEnding.toUpperCase()}` : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {notice && <div className="notice error-notice" aria-live="polite"><span>{notice}</span><button onClick={() => setNotice(null)}>关闭提示</button></div>}
      {tabState.warning && <p className="notice" role="alert">{tabState.warning}</p>}
      {commandState.warning && <p className="notice" role="alert">{commandState.warning}</p>}
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
          <button className="plain-button" {...commandProps('file.new')} onClick={() => void executeCommand('file.new')}>新建文本</button>
          <button className="plain-button" {...commandProps('file.open')} onClick={() => void executeCommand('file.open')}>打开文件</button>
          <button className="plain-button" {...commandProps('workspace.open')} onClick={() => void executeCommand('workspace.open')}>打开文件夹</button>
          <button className="plain-button" {...commandProps('file.save')} onClick={() => void executeCommand('file.save')}>保存</button>
          <button className="plain-button" {...commandProps('editor.find')} onClick={() => void executeCommand('editor.find')}>查找</button>
          <button id="save-all-button" className="plain-button" {...commandProps('file.saveAll')} onClick={() => void executeCommand('file.saveAll')}>全部保存</button>
          <button className="plain-button" {...commandProps('file.saveAs')} onClick={() => void executeCommand('file.saveAs')}>另存为</button>
          <button className="plain-button" {...commandProps('file.saveCopy')} onClick={() => void executeCommand('file.saveCopy')}>保存副本</button>
          <button type="button" className="plain-button tab-pin-control" {...commandProps('tabs.pin')} onClick={() => void executeCommand('tabs.pin')}>{tabState.previewId === current.id ? '固定标签' : '已固定'}</button>
          <label className="toolbar-field">缩进
            <select aria-label="缩进宽度" value={current.indentWidth} onChange={event => {
              const width = Number(event.currentTarget.value);
              if (width === 2 || width === 4 || width === 8) documents.setIndentWidth(current.id, width);
            }}>
              <option value="2">2 空格</option><option value="4">4 空格</option><option value="8">8 空格</option>
            </select>
          </label>
          <label className="toolbar-field">语言
            <select aria-label="语言模式" value={current.languageSource === 'auto' ? 'auto' : current.languageId}
              onChange={event => documents.setLanguage(current.id, event.currentTarget.value as 'auto' | LanguageId)}>
              <option value="auto">自动（{languageLabel(current.languageId)}）</option>
              {languageOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="toolbar-check"><input type="checkbox" checked={current.bracketMatching}
            onChange={event => documents.setBracketMatching(current.id, event.currentTarget.checked)} />匹配括号</label>
          <label className="toolbar-check"><input type="checkbox" checked={current.closeBrackets}
            onChange={event => documents.setCloseBrackets(current.id, event.currentTarget.checked)} />自动配对</label>
        </div>
        <FindBar registry={documents} id={current.id} version={current.version} readOnlyReason={current.readOnlyReason}
          request={findRequest?.id === current.id ? findRequest : null} open={findOpen} onClose={() => setFindOpen(false)} />
        <SaveAllResults />
        <TabStrip documents={snapshot.documents} activeId={snapshot.activeId} previewId={tabState.previewId}
          busy={busy || savingCount > 0 || batchBusy || closingCount > 0} onSelect={selectTab}
          onPin={id => { if (tabs.getSnapshot().previewId === id) void executeCommand('tabs.pin', id); }} onClose={id => void executeCommand('file.close', id)} />
        <EditorDocument key={snapshot.activeId} registry={documents} id={snapshot.activeId} autoFocus={autoFocus} />
      </> : <div className="welcome">
        <div className="welcome-content">
          <p className="welcome-eyebrow">轻羽 FEATHERPAD</p>
          <h1>快开文件，专心编辑。</h1>
          <p className="welcome-description">给文字一处安静的地方。</p>
          <div className="welcome-actions">
            <button className="plain-button" {...commandProps('file.new')} onClick={() => void executeCommand('file.new')}>新建文本</button>
            <button className="primary-button" {...commandProps('file.open')} onClick={() => void executeCommand('file.open')}>打开文件</button>
            <button className="plain-button" {...commandProps('workspace.open')} onClick={() => void executeCommand('workspace.open')}>打开文件夹</button>
          </div>
        </div>
      </div>}
      {paletteMode && <CommandPalette mode={paletteMode} items={paletteMode === 'files' ? quickFiles?.items ?? [] : commands.list(commandAvailability)}
        scope={paletteMode === 'files' ? quickFiles?.scope ?? '' : ''}
        onClose={() => { setPaletteMode(null); requestAnimationFrame(restorePaletteFocus); }}
        onPick={id => {
          const target = paletteMode === 'files' ? quickFiles?.targets.get(id) : undefined;
          setPaletteMode(null);
          requestAnimationFrame(() => {
            restorePaletteFocus();
            if (paletteMode === 'commands') void executeCommand(id);
            else if (target?.kind === 'file') void openTreeFile(target.ref, 'pinned');
            else if (target?.kind === 'document' && documents.getDocument(target.id)) {
              setAutoFocus(true);
              documents.activate(target.id);
              requestAnimationFrame(() => documents.focus(target.id));
            } else setError('文件候选已变化，请重新打开快速打开面板。');
          });
        }}
        onBind={(id, value) => commands.setBinding(id, value)} onResetBindings={() => commands.resetBindings()} />}
      {closeTarget && <CloseDialog key={closeTarget.id} target={closeTarget} registry={documents} tabs={tabs}
        onClosed={() => { setCloseTarget(null); focusAfterClose(); }}
        onCancel={() => {
          setCloseTarget(null);
          requestAnimationFrame(() => {
            if (closeOrigin.current?.isConnected) closeOrigin.current.focus();
            else { const id = documents.getSnapshot().activeId; if (id) documents.focus(id); }
          });
        }} />}
      {trashEntry && <TrashDialog entry={trashEntry} store={workspace} documents={snapshot.documents}
        captureSnapshots={ids => documents.captureTrashSnapshots(ids)}
        saveDocuments={async ids => {
          setSavingCount(count => count + 1);
          try {
            for (const id of ids) {
              if (!documents.getDocument(id)?.summary.dirty) continue;
              const result = await saves.save(id);
              if (!result.ok) return result.error.code === 'CANCELLED' ? '保存已取消，项目尚未回收。' : result.error.message;
              if (documents.getDocument(id)?.summary.dirty) return '保存后仍有新修改，请保留草稿或重新保存后确认。';
            }
            return null;
          } finally { setSavingCount(count => count - 1); }
        }}
        onTrashed={result => {
          documents.markTrashed(result);
          setTrashEntry(null);
          setNotice(`已移至系统回收站。${result.missingDocumentIds.length ? '已打开的内容仍保留，可另存为新文件。' : ''}`);
          requestAnimationFrame(() => {
            const id = documents.getSnapshot().activeId;
            if (id) documents.focus(id);
            else window.document.querySelector<HTMLButtonElement>('[aria-label="刷新目录树"]')?.focus();
          });
        }} onClose={() => setTrashEntry(null)} />}
    </Shell>
  );
}

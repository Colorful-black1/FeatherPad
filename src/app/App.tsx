import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { availableMonitors, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { Shell } from '../shared/ui/Shell';
import { CommandPalette } from '../shared/ui/CommandPalette';
import { files } from '../bridge/files';
import { EditorDocument } from '../features/editor/EditorDocument';
import { ReadOnlyOpenChoices } from '../features/editor/ReadOnlyOpenChoices';
import { offerReadOnlyOpen, type ReadOnlyOpenCandidate } from '../features/editor/read-only-open';
import { EditorStatus } from '../features/editor/EditorStatus';
import { EncodingMenu } from '../features/editor/EncodingMenu';
import type { EncodingId } from '../shared/contracts/encoding';
import { fontSizeAfterZoom, listenEditorFontWheel, type FontZoomAction } from '../features/editor/view-settings';
import { languageLabel, languageOptions, type LanguageId } from '../features/editor/editor-language';
import { documents } from '../features/editor/documents';
import { tabs } from '../features/editor/tabs';
import { TabStrip } from '../features/editor/TabStrip';
import { CloseDialog, type CloseTarget } from '../features/editor/CloseDialog';
import { saves } from '../features/editor/save';
import { recoveries } from '../features/editor/recovery';
import { externalChanges } from '../features/editor/external-changes';
import { ConflictBanner } from '../features/editor/ConflictBanner';
import { restoreRecoveryOnce } from '../features/desktop/recovery-startup';
import { session } from '../features/desktop/session';
import { hotExit } from '../features/desktop/hot-exit';
import { HotExitDialog } from '../features/desktop/HotExitDialog';
import { fitSessionBounds } from '../features/desktop/window-restore';
import { RecoveryPanel } from '../features/desktop/RecoveryPanel';
import { settings } from '../features/desktop/settings';
import { SettingsDialog } from '../features/desktop/SettingsDialog';
import { applySettingsToEditors } from '../features/desktop/settings-effects';
import { languagePreferences } from '../features/desktop/language-preferences';
import { saveAll } from '../features/editor/save-all';
import { SaveAllResults } from '../features/editor/SaveAllResults';
import { autoSaves } from '../features/editor/autosave';
import { AutoSaveStatus } from '../features/editor/AutoSaveStatus';
import { FindBar } from '../features/search-tools/FindBar';
import type { SearchScope } from '../features/search-tools/search-query';
import { Explorer } from '../features/workspace/Explorer';
import { RecentList } from '../features/workspace/RecentList';
import { TrashDialog } from '../features/workspace/TrashDialog';
import { workspace } from '../features/workspace/store';
import {
  addRecentEntry, clearRecentHistory, readRecentHistory, recentFileCandidate, recentGrantIds,
  recentHistoryItemsSetting, recentWorkspaceCandidate, removeRecentEntry, writeRecentHistory,
  type RecentCandidate, type RecentEntry,
} from '../features/workspace/recent';
import type { DirectoryEntry, DocumentId, FileRef, OpenDocument, RenamedDocument, SaveTransactionCandidate } from '../shared/contracts/files';
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
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const settingsState = useSyncExternalStore(settings.subscribe, settings.getSnapshot);
  const dark = settingsState.settings.theme === 'system' ? systemDark : settingsState.settings.theme === 'dark';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const snapshot = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const tabState = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
  const batch = useSyncExternalStore(saveAll.subscribe, saveAll.getSnapshot);
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const exitState = useSyncExternalStore(hotExit.subscribe, hotExit.getSnapshot);
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const recentEntries = readRecentHistory(settingsState.user[recentHistoryItemsSetting]);
  const batchBusy = batch.phase === 'running' || batch.phase === 'cancelling';
  const current = snapshot.documents.find(document => document.id === snapshot.activeId);
  const currentSource = current ? documents.getDocument(current.id)?.source : undefined;
  const currentReference = currentSource?.ref;
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
  const [previewCandidates, setPreviewCandidates] = useState<ReadOnlyOpenCandidate[]>([]);
  const [trashEntry, setTrashEntry] = useState<DirectoryEntry | null>(null);
  const opening = useRef(false);
  const [commands] = useState(createAppCommands);
  const commandState = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const paletteOrigin = useRef<HTMLElement | null>(null);
  const [saveTransactions, setSaveTransactions] = useState<SaveTransactionCandidate[]>([]);
  const transactionCopies = useRef(new Map<string, DocumentId>());

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--font-mono', `"${settingsState.settings.fontFamily}", Consolas, "Microsoft YaHei UI", monospace`);
    document.documentElement.style.setProperty('--editor-size', `${settingsState.settings.fontSize}px`);
    document.documentElement.style.setProperty('--editor-line-height', String(settingsState.settings.lineHeight));
  }, [dark, settingsState.settings.fontFamily, settingsState.settings.fontSize, settingsState.settings.lineHeight]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => applySettingsToEditors(settings, documents), []);
  useEffect(() => languagePreferences.start(setNotice), []);
  useEffect(() => autoSaves.start(), []);

  useEffect(() => {
    if (!Reflect.get(window, '__TAURI_INTERNALS__')) return;
    const stopSettings = settings.start(workspace, { load: false });
    let active = true;
    let stopRecovery: (() => void) | null = null;
    let stopSession: (() => void) | null = null;
    let stopExternal: (() => void) | null = null;
    let unlistenClose: (() => void) | null = null;
    let releaseStartup!: () => void;
    const startupReady = new Promise<void>(resolve => { releaseStartup = resolve; });
    const appWindow = getCurrentWindow();
    void appWindow.onCloseRequested(async event => {
      event.preventDefault();
      await startupReady;
      await settings.flushFontSize();
      await languagePreferences.flush();
      if (active) await hotExit.prepare();
    }).then(unlisten => {
      if (active) unlistenClose = unlisten;
      else unlisten();
    }).catch(() => {
      if (active) setError('无法注册安全退出监听；请先保存所有修改再关闭窗口。');
    });
    void (async () => {
      const notices: string[] = [];
      try {
        const loadedSettings = await settings.load();
        const restoreGrantIds = loadedSettings.ok
          ? recentGrantIds(readRecentHistory(loadedSettings.value.settings[recentHistoryItemsSetting]))
          : [];
        const loaded = await session.load(restoreGrantIds);
        let sources = new Map<DocumentId, OpenDocument>();
        if (!loaded.ok) setError(previous => previous
          ? `${previous}；无法读取会话状态：${loaded.error.message}`
          : `无法读取会话状态：${loaded.error.message}`);
        else {
          if (loaded.value.warning) notices.push(loaded.value.warning);
          if (loaded.value.session) {
            const savedWindow = loaded.value.session.windows.find(window => window.windowId === 'main')
              ?? loaded.value.session.windows[0];
            if (savedWindow) {
              try {
                const [monitors, outer, inner, scale] = await Promise.all([
                  availableMonitors(), appWindow.outerSize(), appWindow.innerSize(), appWindow.scaleFactor(),
                ]);
                const frame = { width: (outer.width - inner.width) / scale,
                  height: (outer.height - inner.height) / scale };
                const fitted = fitSessionBounds(savedWindow.bounds, monitors.map(monitor => {
                  const position = monitor.workArea.position.toLogical(monitor.scaleFactor);
                  const size = monitor.workArea.size.toLogical(monitor.scaleFactor);
                  return { x: position.x, y: position.y, width: size.width, height: size.height };
                }), frame);
                if (fitted) {
                  await appWindow.setSize(new LogicalSize(fitted.width, fitted.height));
                  await appWindow.setPosition(new LogicalPosition(fitted.x, fitted.y));
                }
              } catch {
                notices.push('窗口位置未能恢复，已使用系统提供的当前位置。');
              }
            }
            const restored = await session.restoreSources(
              loaded.value.session,
              loaded.value.restoredGrantIds,
            );
            sources = restored.sources;
            notices.push(...restored.warnings);
          }
        }
        const recovery = await restoreRecoveryOnce(sources, loaded.ok ? loaded.value.session ?? undefined : undefined);
        if (!recovery.ok) setError(`无法读取本地恢复副本：${recovery.error.message}`);
        else {
          if (active) setSaveTransactions(recovery.value.saveTransactions);
          if (recovery.value.restored.length > 0) {
            notices.push(`已恢复 ${recovery.value.restored.length} 个未保存文档。`);
          }
          if (recovery.value.corruptEntries > 0) {
            notices.push(`检测到 ${recovery.value.corruptEntries} 个损坏恢复副本，已隔离且未删除。`);
          }
          notices.push(...recovery.value.warnings);
        }
        if (loaded.ok && loaded.value.session) {
            const applied = session.apply(loaded.value.session);
            notices.push(...applied.warnings);
        }
      } catch {
        setError(previous => previous
          ? `${previous}；启动恢复未完成，当前编辑仍可使用。`
          : '启动恢复未完成，当前编辑仍可使用。');
      } finally {
        if (active) {
          stopRecovery = recoveries.start();
          stopSession = session.start();
          stopExternal = externalChanges.start();
          if (notices.length > 0) setNotice(notices.join(' '));
        }
        releaseStartup();
      }
    })();
    return () => {
      active = false;
      releaseStartup();
      unlistenClose?.();
      stopRecovery?.();
      stopSession?.();
      stopExternal?.();
      stopSettings();
      if (hotExit.getSnapshot().phase !== 'idle') hotExit.resume();
    };
  }, []);

  const rememberRecentCandidate = useCallback(async (candidate: RecentCandidate): Promise<RecentEntry | null> => {
    session.markGrantAvailable(candidate.ref.grantId);
    const current = readRecentHistory(settings.getSnapshot().user[recentHistoryItemsSetting]);
    const next = addRecentEntry(current, candidate);
    const saved = await settings.updatePersistedValue(recentHistoryItemsSetting, writeRecentHistory(next));
    if (!saved.ok) {
      setNotice(`项目已打开，但最近记录未保存：${saved.error.message}`);
      return null;
    }
    const flushed = await session.flush();
    if (!flushed.ok) setNotice(`最近记录已保存，但用于重启后再次打开的授权未确认：${flushed.error.message}`);
    return next.find(entry => entry.canonicalIdentity === candidate.canonicalIdentity
      && entry.kind === candidate.kind) ?? null;
  }, [setNotice]);

  const rememberRecentFile = useCallback(async (id: DocumentId) => {
    const source = documents.getDocument(id)?.source;
    if (!source) return;
    session.markGrantAvailable(source.ref.grantId);
    if (!settings.getSnapshot().settings.recentHistoryEnabled) return;
    await rememberRecentCandidate(recentFileCandidate(source));
  }, [rememberRecentCandidate]);

  const rememberRecentWorkspace = useCallback(async (grant: FileRef, displayName: string) => {
    session.markGrantAvailable(grant.grantId);
    if (!settings.getSnapshot().settings.recentHistoryEnabled) return;
    await rememberRecentCandidate(recentWorkspaceCandidate(grant, displayName));
  }, [rememberRecentCandidate]);

  const persistRecentEntries = useCallback(async (entries: readonly RecentEntry[]): Promise<string | null> => {
    const result = await settings.updatePersistedValue(recentHistoryItemsSetting, writeRecentHistory(entries));
    return result.ok ? null : result.error.message;
  }, []);

  const applyRecentRenames = useCallback(async (renamed: readonly RenamedDocument[]) => {
    const current = readRecentHistory(settings.getSnapshot().user[recentHistoryItemsSetting]);
    const byIdentity = new Map(renamed.map(mapping => [
      documents.getDocument(mapping.documentId)?.source?.canonicalIdentity,
      mapping,
    ] as const).filter((item): item is readonly [string, RenamedDocument] => !!item[0]));
    if (byIdentity.size === 0) return;
    let changed = false;
    const next = current.map(entry => {
      const mapping = byIdentity.get(entry.canonicalIdentity);
      if (!mapping) return entry;
      changed = true;
      const displayPath = mapping.displayPath.slice(0, 4096);
      return {
        ...entry,
        ref: { ...mapping.ref },
        displayPath,
        title: (displayPath.split(/[\\/]/).pop() || displayPath).slice(0, 512),
      };
    });
    if (!changed) return;
    const error = await persistRecentEntries(next);
    if (error) setNotice(`最近记录的路径未能随重命名更新：${error}`);
  }, [persistRecentEntries, setNotice]);

  const openOne = useCallback(async (
    reference: FileRef,
    intent: 'preview' | 'pinned' = 'pinned',
    remember = true,
  ): Promise<string | null> => {
    const result = await tabs.open(reference, intent);
    if (result.ok) {
      if (window.matchMedia('(max-width: 1099px)').matches && window.document.activeElement?.closest('.sidebar')) {
        setSidebarOpen(false);
        requestAnimationFrame(() => documents.focus(result.value.id));
      }
      if (remember) await rememberRecentFile(result.value.id);
      else session.markGrantAvailable(reference.grantId);
      if (result.value.warning && result.value.warning !== tabs.getSnapshot().warning) setNotice(result.value.warning);
      return null;
    }
    setPreviewCandidates(candidates => offerReadOnlyOpen(candidates, reference, result.error));
    return result.error.message;
  }, [rememberRecentFile, setSidebarOpen]);

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

  const openReadOnlyPreview = useCallback(async (candidate: ReadOnlyOpenCandidate, encoding?: EncodingId) => {
    if (opening.current) return;
    opening.current = true;
    setError(null);
    setBusy(true);
    setAutoFocus(true);
    try {
      const mode = encoding && candidate.mode === 'text-preview' ? undefined : candidate.mode;
      const result = await tabs.open(candidate.ref, 'pinned', mode, encoding);
      if (result.ok) {
        await rememberRecentFile(result.value.id);
        setPreviewCandidates(candidates => candidates.filter(item => item !== candidate));
      } else {
        setError(result.error.message);
        setPreviewCandidates(candidates => offerReadOnlyOpen(candidates, candidate.ref, result.error));
      }
    } finally { opening.current = false; setBusy(false); }
  }, [rememberRecentFile, setBusy, setError, setAutoFocus]);

  const newFile = useCallback(async () => { setAutoFocus(true); await tabs.createUntitled(); }, [setAutoFocus]);

  const openTransactionCopy = useCallback(async (receiptId: string): Promise<string | null> => {
    const existing = transactionCopies.current.get(receiptId);
    if (existing && documents.getDocument(existing)) {
      documents.activate(existing);
      documents.focus(existing);
      return null;
    }
    const loaded = await files.loadSaveTransaction({ receiptId });
    if (!loaded.ok) return loaded.error.message;
    if (documents.isHotExitFrozen()) return '正在退出，恢复副本尚未打开；原记录仍保留。';
    const id = documents.openTransactionDraft(loaded.value);
    transactionCopies.current.set(receiptId, id);
    setAutoFocus(true);
    const protectedCopy = await recoveries.flush(id);
    return protectedCopy.ok ? null : `副本已在编辑器中打开，但恢复快照未更新：${protectedCopy.error.message} 原记录仍保留，请先另存。`;
  }, []);

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

  const saveExitDrafts = useCallback(async (): Promise<string | null> => {
    const ids = documents.getSnapshot().documents.filter(document => document.dirty).map(document => document.id);
    if (ids.length === 0) return null;
    setSavingCount(count => count + 1);
    try {
      for (const id of ids) {
        const result = await saves.saveAs(id, 'save-as');
        if (!result.ok) {
          return result.error.code === 'CANCELLED'
            ? '另存已取消；应用保持打开，当前正文仍在内存中。'
            : `另存失败：${result.error.message}`;
        }
        if (documents.getDocument(id)?.summary.dirty) {
          return '另存完成后文档仍有未确认修改；应用保持打开。';
        }
      }
      return null;
    } finally {
      setSavingCount(count => count - 1);
    }
  }, [setSavingCount]);

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
        await rememberRecentWorkspace(result.value.grant, result.value.displayName);
      }
    } finally { opening.current = false; setBusy(false); }
  }, [rememberRecentWorkspace, setBusy]);

  const openRecent = useCallback(async (entry: RecentEntry): Promise<string | null> => {
    if (entry.kind === 'workspace') {
      workspace.setRoot({ grant: entry.ref, displayName: entry.displayPath });
      setSidebarOpen(true);
      await rememberRecentWorkspace(entry.ref, entry.displayPath);
      return null;
    }
    setAutoFocus(true);
    setBusy(true);
    setError(null);
    try {
      return await openOne(entry.ref, 'pinned');
    } finally { setBusy(false); }
  }, [openOne, rememberRecentWorkspace, setBusy]);

  const repairRecent = useCallback(async (entry: RecentEntry): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      let stored: RecentEntry | null = null;
      if (entry.kind === 'workspace') {
        const selected = await files.chooseFolder();
        if (!selected.ok) return selected.error.message;
        if (!selected.value.grant || !selected.value.displayName) return '未重新选择工作区。';
        workspace.setRoot({ grant: selected.value.grant, displayName: selected.value.displayName });
        setSidebarOpen(true);
        stored = await rememberRecentCandidate(recentWorkspaceCandidate(
          selected.value.grant,
          selected.value.displayName,
        ));
      } else {
        const selected = await files.chooseFiles(false);
        if (!selected.ok) return selected.error.message;
        const reference = selected.value.grants[0];
        if (!reference) return selected.value.failures[0]?.error.message ?? '未重新选择文件。';
        setAutoFocus(true);
        const failure = await openOne(reference, 'pinned', false);
        if (failure) return `已重新选择，但无法打开：${failure}`;
        const id = documents.getSnapshot().activeId;
        const source = id ? documents.getDocument(id)?.source : undefined;
        if (!source) return '文件已打开，但无法建立最近记录。';
        stored = await rememberRecentCandidate(recentFileCandidate(source));
      }
      if (!stored) return '已重新打开，但最近记录未能保存。';
      const current = readRecentHistory(settings.getSnapshot().user[recentHistoryItemsSetting]);
      const previous = current.find(item => item.id === entry.id);
      if (!previous || previous.id === stored.id) return null;
      const removalError = await persistRecentEntries(removeRecentEntry(current, entry.id));
      return removalError ? `已重新打开新项目，但旧记录未能移除：${removalError}` : null;
    } finally { setBusy(false); }
  }, [openOne, persistRecentEntries, rememberRecentCandidate, setBusy]);

  const removeRecent = useCallback(async (entry: RecentEntry): Promise<string | null> => {
    const current = readRecentHistory(settings.getSnapshot().user[recentHistoryItemsSetting]);
    return persistRecentEntries(removeRecentEntry(current, entry.id));
  }, [persistRecentEntries]);

  const clearRecent = useCallback(async (): Promise<string | null> =>
    persistRecentEntries(clearRecentHistory()), [persistRecentEntries]);

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
  const openSettings = useCallback(() => {
    settingsOrigin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    setAutoFocus(false); setSettingsOpen(true);
  }, []);
  const restorePaletteFocus = useCallback(() => {
    if (paletteOrigin.current?.isConnected) paletteOrigin.current.focus();
    else { const id = documents.getSnapshot().activeId; if (id) documents.focus(id); }
  }, []);
  const zoomEditor = useCallback((action: FontZoomAction) => {
    const id = documents.getSnapshot().activeId;
    if (!id || documents.getDocument(id)?.summary.closing || documents.isHotExitFrozen()) return;
    const current = settings.getSnapshot();
    const size = fontSizeAfterZoom(current.settings.fontSize, action);
    if (size === current.settings.fontSize && size === current.user.fontSize) return;
    void settings.setFontSize(size).then(result => {
      if (!result.ok) setNotice(`编辑字号仅本次生效：${result.error.message}`);
      else setNotice(previous => previous?.startsWith('编辑字号仅本次生效：') ? null : previous);
    });
  }, [setNotice]);
  useEffect(() => listenEditorFontWheel(window, zoomEditor, () => documents.isHotExitFrozen()), [zoomEditor]);
  const commandActions = useMemo<AppCommandActions>(() => ({
    'file.new': newFile, 'file.open': openFile, 'workspace.open': openFolder, 'file.save': saveCurrent,
    'file.saveAs': () => saveDestination(), 'file.saveCopy': () => saveDestination('copy'),
    'file.saveAll': async () => { await saveAll.run(); },
    'file.close': async () => { const id = documents.getSnapshot().activeId; if (id) await requestClose(id); },
    'editor.find': openFind, 'tabs.pin': () => { const id = documents.getSnapshot().activeId; if (id) tabs.pin(id); },
    'editor.fontIncrease': () => zoomEditor('in'), 'editor.fontDecrease': () => zoomEditor('out'),
    'editor.fontReset': () => zoomEditor('reset'),
    'view.sidebar': () => setSidebarOpen(open => !open),
    'view.theme': () => settings.setSession('theme', dark ? 'light' : 'dark'), 'settings.open': openSettings,
    'commands.open': () => openPalette('commands'), 'files.quickOpen': () => openPalette('files'),
  }), [newFile, openFile, openFolder, saveCurrent, saveDestination, requestClose, openFind, openPalette, openSettings, dark, zoomEditor]);

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
      railActions={<button className="icon-button" aria-label="打开设置" {...commandProps('settings.open')}
        title={commands.disabledReason('settings.open', commandAvailability) ?? '打开设置'}
        onClick={() => void executeCommand('settings.open')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 4 3 2 3 1v4l-3 1-3 2-1 4H9l-1-4-3-2-3-1v-4l3-1 3-2Z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>}
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
      sidebar={<div className="sidebar-stack">
        <RecentList entries={recentEntries} availableGrantIds={sessionState.availableGrantIds}
          enabled={settingsState.settings.recentHistoryEnabled}
          busy={busy || savingCount > 0 || batchBusy || closingCount > 0}
          onOpen={openRecent} onRepair={repairRecent} onRemove={removeRecent} onClear={clearRecent} />
        <Explorer currentReference={currentReference} onOpen={(reference, intent) => void openTreeFile(reference, intent ?? 'preview')}
          onTrash={setTrashEntry} mutationBlocked={busy || savingCount > 0 || batchBusy || closingCount > 0}
          onRenamed={renamed => {
            documents.applyRenamedPaths(renamed);
            void applyRecentRenames(renamed);
          }} />
      </div>}
      status={<><span>{closingCount > 0 || current?.closing ? '正在关闭…' : batchBusy ? '正在全部保存…' : savingCount > 0 ? '正在保存…' : busy ? '正在打开…' : current ? current.readOnlyReason ? '只读' : current.dirty ? '未保存修改' : current.displayPath ? '未修改' : '未命名' : '就绪'}</span>{current && <><span role="group" aria-label="光标与字数" aria-live="off"><EditorStatus registry={documents} id={current.id} summary={current} /></span><span aria-label="编辑字号">{settingsState.settings.fontSize}px</span></>}<span className="status-end">{current ? `${current.format.encoding.toUpperCase()}${current.format.bom === 'none' ? '' : ' BOM'} · ${current.format.lineEnding.toUpperCase()}` : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {notice && <div className="notice error-notice" aria-live="polite"><span>{notice}</span><button onClick={() => setNotice(null)}>关闭提示</button></div>}
      {tabState.warning && <p className="notice" role="alert">{tabState.warning}</p>}
      {commandState.warning && <p className="notice" role="alert">{commandState.warning}</p>}
      <RecoveryPanel candidates={saveTransactions} onOpen={openTransactionCopy}
        missingSources={sessionState.missingSources} onForget={id => session.forgetMissing(id)}
        onReselect={kind => { if (kind === 'workspace') void openFolder(); else void openFile(); }}
        blocked={exitState.phase !== 'idle' || busy || savingCount > 0 || batchBusy || closingCount > 0} />
      <ReadOnlyOpenChoices candidates={previewCandidates}
        busy={busy || savingCount > 0 || batchBusy || closingCount > 0 || exitState.phase !== 'idle'}
        onOpen={candidate => void openReadOnlyPreview(candidate)}
        onOpenEncoding={(candidate, encoding) => void openReadOnlyPreview(candidate, encoding)}
        onCancel={mode => setPreviewCandidates(candidates => candidates.filter(candidate => candidate.mode !== mode))} />
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
          <EncodingMenu key={current.id} registry={documents} summary={current}
            blocked={busy || savingCount > 0 || batchBusy || closingCount > 0 || exitState.phase !== 'idle'} onMessage={setNotice} />
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
            <select aria-label="语言模式" disabled={currentSource?.mode === 'text-preview'}
              value={current.languageSource === 'auto' ? 'auto' : current.languageId}
              onChange={event => { void languagePreferences.choose(current.id, event.currentTarget.value as 'auto' | LanguageId); }}>
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
        <AutoSaveStatus id={current.id} />
        <TabStrip documents={snapshot.documents} activeId={snapshot.activeId} previewId={tabState.previewId}
          busy={busy || savingCount > 0 || batchBusy || closingCount > 0} onSelect={selectTab}
          onPin={id => { if (tabs.getSnapshot().previewId === id) void executeCommand('tabs.pin', id); }} onClose={id => void executeCommand('file.close', id)} />
        <ConflictBanner key={`conflict-${snapshot.activeId}`} id={snapshot.activeId} registry={documents} coordinator={externalChanges} saving={saves} />
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
      {settingsOpen && <SettingsDialog coordinator={settings} onClose={() => {
        setSettingsOpen(false);
        requestAnimationFrame(() => {
          if (settingsOrigin.current?.isConnected) settingsOrigin.current.focus();
          else { const id = documents.getSnapshot().activeId; if (id) documents.focus(id); }
        });
      }} onShortcuts={() => { setSettingsOpen(false); openPalette('commands'); }} />}
      {exitState.phase !== 'idle' && <HotExitDialog snapshot={exitState}
        onRetry={async () => { await hotExit.prepare(); }}
        onSaveAs={saveExitDrafts}
        onDiscard={async () => { await hotExit.discardAndExit(); }}
        onStay={() => hotExit.resume()} />}
    </Shell>
  );
}

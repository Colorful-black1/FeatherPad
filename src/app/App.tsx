import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { availableMonitors, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { Shell } from '../shared/ui/Shell';
import { CommandPalette } from '../shared/ui/CommandPalette';
import { files } from '../bridge/files';
import { WorkspaceRoots } from '../features/workspace/roots';
import { RootList } from '../features/workspace/RootList';
import { FavoriteList } from '../features/workspace/FavoriteList';
import { favoriteGrantIds, favoritesSetting, mutateFavorites, readFavorites } from '../features/workspace/favorites';
import { useFavorites } from './use-favorites';
import { useWorkspaceFile } from './use-workspace-file';
import { DocumentContent } from '../features/markdown/MarkdownView';
import { ReadOnlyOpenChoices } from '../features/editor/ReadOnlyOpenChoices';
import { offerReadOnlyOpen, type ReadOnlyOpenCandidate } from '../features/editor/read-only-open';
import { EditorStatus } from '../features/editor/EditorStatus';
import { EncodingMenu } from '../features/editor/EncodingMenu';
import type { EncodingId } from '../shared/contracts/encoding';
import { fontSizeAfterZoom, listenEditorFontWheel, type FontZoomAction } from '../features/editor/view-settings';
import { languageLabel, languageOptions, type LanguageId } from '../features/editor/editor-language';
import { editingCommands } from '../features/editor/editing';
import { Breadcrumbs } from '../features/editor/Breadcrumbs';
import { GoToLineDialog } from '../features/editor/GoToLineDialog';
import { OutlineDialog } from '../features/editor/OutlineDialog';
import {
  lineColumnAt, localOutline, NavigationHistory, positionAt, type LineColumn, type NavigationTarget,
} from '../features/editor/navigation';
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
import { mergeSettings } from '../features/desktop/settings-schema';
import { SettingsDialog } from '../features/desktop/SettingsDialog';
import { applySettingsToEditors } from '../features/desktop/settings-effects';
import { languagePreferences } from '../features/desktop/language-preferences';
import { inactiveRecoveryGroups } from '../features/desktop/privacy';
import { saveAll } from '../features/editor/save-all';
import { SaveAllResults } from '../features/editor/SaveAllResults';
import { autoSaves } from '../features/editor/autosave';
import { AutoSaveStatus } from '../features/editor/AutoSaveStatus';
import { FindBar } from '../features/search-tools/FindBar';
import type { SearchScope } from '../features/search-tools/search-query';
import { Explorer } from '../features/workspace/Explorer';
import { RecentList } from '../features/workspace/RecentList';
import { TrashDialog } from '../features/workspace/TrashDialog';
import { workspace, type WorkspaceRoot } from '../features/workspace/store';
import { WorkspaceSync } from '../features/workspace/sync';
import { searchBridge, type SearchFileResult, type SearchMatch } from '../bridge/search';
import {
  replacementBridge,
  type ReplaceBatchOutcome,
  type ReplacementPlan,
  type RollbackBatchOutcome,
} from '../bridge/replacement';
import { WorkspaceSearchPanel, type WorkspaceSearchDraft } from '../features/search-tools/WorkspaceSearchPanel';
import { WorkspaceSearchStore } from '../features/search-tools/workspace-search';
import { ReplacePreviewDialog } from '../features/search-tools/ReplacePreviewDialog';
import { isNativeDropEntries, type NativeDropEntry } from '../bridge/workspace';
import {
  addRecentEntry, clearRecentHistory, readRecentHistory, recentFileCandidate, recentGrantIds,
  recentHistoryItemsSetting, recentWorkspaceCandidate, removeRecentEntry, writeRecentHistory,
  type RecentCandidate, type RecentEntry,
} from '../features/workspace/recent';
import type {
  DirectoryEntry, DocumentId, FileRef, OpenDocument, RecoveryInventory, RenamedDocument, SaveTransactionCandidate,
} from '../shared/contracts/files';
import { ariaShortcut } from '../shared/commands/keyboard';
import { globalShortcutBridge } from '../bridge/global-shortcut';
import {
  appCommandIds,
  createAppCommands,
  type AppCommandActions,
  type AppCommandState,
  type AppCommandId,
} from './register-commands';
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
  const persistedGlobalSettings = mergeSettings(settingsState.user).settings;
  const globalLaunchEnabled = persistedGlobalSettings.globalLaunchEnabled;
  const globalLaunchShortcut = persistedGlobalSettings.globalLaunchShortcut;
  const batchBusy = batch.phase === 'running' || batch.phase === 'cancelling';
  const current = snapshot.documents.find(document => document.id === snapshot.activeId);
  const primaryEditorId = tabState.primaryId ?? snapshot.activeId;
  const secondaryEditorId = tabState.secondaryId;
  const currentSource = current ? documents.getDocument(current.id)?.source : undefined;
  const currentReference = currentSource?.ref;
  const [navigationHistory] = useState(() => new NavigationHistory());
  const navigationAvailability = useSyncExternalStore(navigationHistory.subscribe, navigationHistory.getSnapshot);
  const [goToOpen, setGoToOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [startupPending, setStartupPending] = useState(() => !!Reflect.get(window, '__TAURI_INTERNALS__'));
  const [autoFocus, setAutoFocus] = useState(true);
  const [openingCount, setOpeningCount] = useState(0);
  const busy = openingCount > 0;
  const setBusy = useCallback((active: boolean) => { setOpeningCount(count => count + (active ? 1 : -1)); }, []);
  const [closingCount, setClosingCount] = useState(0);
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null);
  const [closeQueue, setCloseQueue] = useState<readonly DocumentId[]>([]);
  const closeOrigin = useRef<HTMLElement | null>(null);
  const closingIds = useRef(new Set<DocumentId>());
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceSearch] = useState(() => new WorkspaceSearchStore(searchBridge.run, searchBridge.cancel));
  const [replacementPlan, setReplacementPlan] = useState<ReplacementPlan | null>(null);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [replaceOutcome, setReplaceOutcome] = useState<ReplaceBatchOutcome | null>(null);
  const [rollbackOutcome, setRollbackOutcome] = useState<RollbackBatchOutcome | null>(null);
  const [replacementCommitUnknown, setReplacementCommitUnknown] = useState(false);
  const [previewCandidates, setPreviewCandidates] = useState<ReadOnlyOpenCandidate[]>([]);
  const [trashEntry, setTrashEntry] = useState<DirectoryEntry | null>(null);
  const opening = useRef(false);
  const [commands] = useState(createAppCommands);
  const [workspaceSync] = useState(() => new WorkspaceSync(workspace));
  const commandState = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const paletteOrigin = useRef<HTMLElement | null>(null);
  const [saveTransactions, setSaveTransactions] = useState<SaveTransactionCandidate[]>([]);
  const [recoveryInventory, setRecoveryInventory] = useState<RecoveryInventory | null>(() =>
    Reflect.get(window, '__TAURI_INTERNALS__') ? null : { entries: [], failures: [], startupWarnings: [], storageBytes: 0, saveTransactions: [] });
  const [recoveryInventoryError, setRecoveryInventoryError] = useState<string | null>(null);
  const transactionCopies = useRef(new Map<string, DocumentId>());

  const refreshRecoveryInventory = useCallback(async (): Promise<string | null> => {
    if (!Reflect.get(window, '__TAURI_INTERNALS__')) return null;
    const result = await files.listRecoveryEntries();
    if (!result.ok) {
      setRecoveryInventoryError(result.error.message);
      return result.error.message;
    }
    setRecoveryInventory(result.value);
    setSaveTransactions(result.value.saveTransactions);
    setRecoveryInventoryError(null);
    return null;
  }, []);

  const cleanupInactiveRecovery = useCallback(async (): Promise<string | null> => {
    const inventory = await files.listRecoveryEntries();
    if (!inventory.ok) {
      setRecoveryInventoryError(inventory.error.message);
      return inventory.error.message;
    }
    const active = new Set(documents.getSnapshot().documents.filter(document => document.dirty).map(document => document.id));
    const groups = inactiveRecoveryGroups(inventory.value.entries, active);
    const failures: string[] = [];
    for (const { documentId, throughVersion } of groups) {
      const discarded = await files.discardRecovery({ documentId, throughVersion });
      if (!discarded.ok) failures.push(discarded.error.message);
    }
    await refreshRecoveryInventory();
    if (failures.length > 0) {
      return `已处理 ${groups.length - failures.length} 个文档；${failures.length} 个文档的记录未清理，已保留并可重试。${failures[0]}`;
    }
    const entries = groups.reduce((sum, group) => sum + group.entries, 0);
    return groups.length > 0
      ? `已清理 ${entries} 个非活动恢复条目；活动未保存副本未改动。`
      : '没有可清理的非活动恢复条目。';
  }, [refreshRecoveryInventory]);

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
  useEffect(() => {
    const all = commands.bindings();
    documents.applyCommandBindings(Object.fromEntries(appCommandIds.map(id => [id, all[id] ?? null])));
  }, [commands, commandState.revision]);
  useEffect(() => {
    if (!Reflect.get(window, '__TAURI_INTERNALS__')) return;
    let active = true;
    const enabled = globalLaunchEnabled;
    const shortcut = globalLaunchShortcut;
    void globalShortcutBridge.configure(enabled, shortcut).then(result => {
      if (!active) return;
      if (!result.ok) setError(`全局唤起未注册：${result.error.message} 设置已保留，可修正后重试。`);
      else if (enabled) setNotice(`全局唤起已启用：${shortcut}。`);
    });
    return () => { active = false; };
  }, [globalLaunchEnabled, globalLaunchShortcut]);
  useEffect(() => () => {
    if (Reflect.get(window, '__TAURI_INTERNALS__')) {
      void globalShortcutBridge.configure(false, 'Ctrl+Shift+Space');
    }
  }, []);
  useEffect(() => languagePreferences.start(setNotice), []);
  useEffect(() => autoSaves.start(), []);
  useEffect(() => workspaceSync.start(), [workspaceSync]);
  useEffect(() => {
    if (!Reflect.get(window, '__TAURI_INTERNALS__')) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void searchBridge.listenProgress(progress => workspaceSearch.updateProgress(progress)).then(stop => {
      if (active) unlisten = stop; else stop();
    }).catch(() => setNotice('目录搜索进度监听不可用；搜索本身仍可继续并显示最终结果。'));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [workspaceSearch]);
  useEffect(() => {
    const live = documents.getSnapshot();
    navigationHistory.retainDocuments(new Set(live.documents.map(document => document.id)));
    const active = live.activeId ? documents.getDocument(live.activeId) : undefined;
    if (active) navigationHistory.record({
      documentId: active.summary.id,
      offset: active.state.selection.main.head,
      label: active.summary.displayPath ?? active.summary.title,
    });
  }, [navigationHistory, snapshot.activeId, snapshot.documents.length]);

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
          ? [...new Set([...recentGrantIds(readRecentHistory(loadedSettings.value.settings[recentHistoryItemsSetting])),
            ...favoriteGrantIds(loadedSettings.value.settings[favoritesSetting])])]
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
        if (active) await refreshRecoveryInventory();
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
        if (active) setStartupPending(false);
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
  }, [refreshRecoveryInventory]);

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

  const applyPathMappings = useCallback(async (renamed: readonly RenamedDocument[]) => {
    documents.applyRenamedPaths(renamed);
    await applyRecentRenames(renamed);
    const sources = renamed.map(mapping => documents.getDocument(mapping.documentId)?.source).filter(source => !!source);
    if (sources.length && settings.getSnapshot().user[favoritesSetting] !== undefined) {
      const result = await settings.updatePersistedValue(favoritesSetting, value => {
        let next = value;
        for (const source of sources) {
          const candidate = recentFileCandidate(source);
          const existing = readFavorites(next).find(entry => entry.kind === 'file' && entry.canonicalIdentity === candidate.canonicalIdentity);
          if (existing) next = mutateFavorites(next, { kind: 'rebind', id: existing.id, candidate });
        }
        return next ?? { schemaVersion: 1, entries: [] };
      });
      if (!result.ok) setNotice(`路径已更新，收藏更新未保存：${result.error.message}`);
    }
  }, [applyRecentRenames, setNotice]);
  const roots = useMemo(() => new WorkspaceRoots(workspace, applyPathMappings), [applyPathMappings]);

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
  }, [rememberRecentFile, setSidebarOpen, setNotice]);

  const favorites = useFavorites(roots, openOne, rememberRecentWorkspace);
  const workspaceFile = useWorkspaceFile(roots, setNotice);

  useEffect(() => {
    if (!Reflect.get(window, '__TAURI_INTERNALS__')) return;
    let active = true;
    let stopDrop: (() => void) | null = null;
    void Promise.all([
      listen<NativeDropEntry[]>('featherpad:native-drop', event => {
        if (!active || !isNativeDropEntries(event.payload)) {
          if (active) setError('拖入项目返回了无效的本地授权信息。');
          return;
        }
        void (async () => {
          for (const item of event.payload) {
            if (item.isDirectory) {
              const opened = await roots.openRoot({ grant: item.ref, displayName: item.displayName });
              if (!opened.ok) setError(opened.error.message);
              else {
                setSidebarOpen(true);
                await rememberRecentWorkspace(item.ref, item.displayName);
              }
            } else {
              const message = await openOne(item.ref, 'pinned');
              if (message) setError(message);
            }
          }
        })();
      }),
      listen<{ message?: unknown }>('featherpad:native-drop-error', event => {
        if (active && typeof event.payload?.message === 'string') setError(event.payload.message);
      }),
    ]).then(unlisten => {
      if (active) stopDrop = () => unlisten.forEach(stop => stop());
      else unlisten.forEach(stop => stop());
    }).catch(() => {
      if (active) setError('无法注册外部拖放监听；仍可通过打开命令载入文件。');
    });
    return () => {
      active = false;
      stopDrop?.();
    };
  }, [openOne, rememberRecentWorkspace, roots]);

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

  const focusNavigationTarget = useCallback((target: NavigationTarget) => {
    const document = documents.getDocument(target.documentId);
    if (!document) return false;
    setAutoFocus(false);
    if (documents.getSnapshot().activeId !== target.documentId) documents.activate(target.documentId);
    requestAnimationFrame(() => {
      documents.focusOffset(target.documentId, target.offset);
    });
    return true;
  }, []);

  const currentNavigationTarget = useCallback((): NavigationTarget | null => {
    const id = documents.getSnapshot().activeId;
    const document = id ? documents.getDocument(id) : undefined;
    return document ? {
      documentId: document.summary.id,
      offset: document.state.selection.main.head,
      label: document.summary.displayPath ?? document.summary.title,
    } : null;
  }, []);

  const goToPosition = useCallback((position: LineColumn) => {
    const id = documents.getSnapshot().activeId;
    const document = id ? documents.getDocument(id) : undefined;
    if (!document) return;
    const currentTarget = currentNavigationTarget();
    if (currentTarget) navigationHistory.record(currentTarget);
    const target = positionAt(document.state, position);
    documents.focusOffset(document.summary.id, target.offset);
    navigationHistory.record({
      documentId: document.summary.id,
      offset: target.offset,
      label: `${document.summary.displayPath ?? document.summary.title}:${target.line}:${target.column}`,
    });
    if (target.clamped) setNotice(`目标行列超出当前文档范围，已移动到 ${target.line}:${target.column}。`);
  }, [currentNavigationTarget, navigationHistory, setNotice]);

  const navigateBack = useCallback(() => {
    const target = navigationHistory.back();
    if (!target) return false;
    return focusNavigationTarget(target);
  }, [focusNavigationTarget, navigationHistory]);

  const navigateForward = useCallback(() => {
    const target = navigationHistory.forward();
    if (!target) return false;
    return focusNavigationTarget(target);
  }, [focusNavigationTarget, navigationHistory]);

  const requestCloseBatch = useCallback(async (requestedIds: readonly DocumentId[]) => {
    if (batchBusy) return;
    const ids = [...new Set(requestedIds)];
    setAutoFocus(false);
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (!id || closingIds.current.has(id)) continue;
      const document = documents.getDocument(id);
      if (!document) continue;
      if (document.summary.dirty) {
        closeOrigin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
        setCloseQueue(ids.slice(index + 1));
        setCloseTarget({ id, version: document.summary.version });
        return;
      }
      closingIds.current.add(id);
      setClosingCount(count => count + 1);
      try {
        const result = await tabs.close(id, document.summary.version, 'clean');
        if (!result.ok || !result.value.closed) {
          setCloseQueue([]);
          setError(result.ok ? '文档没有关闭，已停止后续批量关闭。' : result.error.message);
          focusAfterClose();
          return;
        }
      } finally {
        closingIds.current.delete(id);
        setClosingCount(count => count - 1);
      }
    }
    focusAfterClose();
  }, [batchBusy, focusAfterClose, setAutoFocus, setCloseQueue, setCloseTarget, setClosingCount]);

  const requestClose = useCallback(async (id: DocumentId) => requestCloseBatch([id]),
    [requestCloseBatch]);

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
      const result = await roots.chooseRoot();
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value) {
        setSidebarOpen(true);
        await rememberRecentWorkspace(result.value.grant, result.value.displayName);
      }
    } finally { opening.current = false; setBusy(false); }
  }, [rememberRecentWorkspace, setBusy, roots]);

  const addRoot = useCallback(async () => {
    if (opening.current) return;
    opening.current = true; setBusy(true); setError(null);
    try {
      const result = await roots.chooseRoot(true);
      if (!result.ok) setError(result.error.message);
      else if (result.value) await rememberRecentWorkspace(result.value.grant, result.value.displayName);
    } finally { opening.current = false; setBusy(false); }
  }, [rememberRecentWorkspace, setBusy, roots]);

  const removeRoot = useCallback(async (root: WorkspaceRoot) => {
    if (opening.current) return;
    opening.current = true; setBusy(true); setError(null);
    try {
      const result = await roots.removeRoot(root);
      if (!result.ok) setError(result.error.message);
      else await session.flush();
    } finally { opening.current = false; setBusy(false); }
  }, [roots, setBusy]);

  const openRecent = useCallback(async (entry: RecentEntry): Promise<string | null> => {
    if (entry.kind === 'workspace') {
      const result = await roots.openRoot({ grant: entry.ref, displayName: entry.displayPath });
      if (!result.ok) return result.error.message;
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
  }, [openOne, rememberRecentWorkspace, setBusy, roots]);

  const repairRecent = useCallback(async (entry: RecentEntry): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      let stored: RecentEntry | null = null;
      if (entry.kind === 'workspace') {
        const selected = await files.chooseFolder();
        if (!selected.ok) return selected.error.message;
        if (!selected.value.grant || !selected.value.displayName) return '未重新选择工作区。';
        const opened = await roots.openRoot({ grant: selected.value.grant, displayName: selected.value.displayName });
        if (!opened.ok) return opened.error.message;
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
  }, [openOne, persistRecentEntries, rememberRecentCandidate, setBusy, roots]);

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
      tabCount: snapshot.documents.length,
      cleanTabCount: snapshot.documents.filter(document => !document.dirty && !document.closing).length,
      isSplit: !!tabs.getSnapshot().secondaryId, canReopen: tabs.getSnapshot().recentlyClosed.length > 0,
      canNavigateBack: navigationAvailability.canGoBack,
      canNavigateForward: navigationAvailability.canGoForward,
      hasWorkspace: workspace.getSnapshot().roots.length > 0,
      opening: busy, saving: savingCount > 0, closing: closingCount > 0 || !!active?.closing,
      batchBusy: batch.phase === 'running' || batch.phase === 'cancelling' };
  }, [busy, savingCount, closingCount, navigationAvailability]);
  const commandAvailability: AppCommandState = {
    hasDocument: !!current, readOnlyReason: current?.readOnlyReason ?? null, canSaveAs: current?.canSaveAs ?? false,
    hasDirty: snapshot.documents.some(document => document.dirty), isPreview: !!current && tabState.previewId === current.id,
    tabCount: snapshot.documents.length,
    cleanTabCount: snapshot.documents.filter(document => !document.dirty && !document.closing).length,
    isSplit: !!tabState.secondaryId, canReopen: tabState.recentlyClosed.length > 0,
    canNavigateBack: navigationAvailability.canGoBack,
    canNavigateForward: navigationAvailability.canGoForward,
    hasWorkspace: workspaceState.roots.length > 0,
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
  const runEditingCommand = useCallback((name: keyof typeof editingCommands) => {
    const id = documents.getSnapshot().activeId;
    if (!id) return;
    if (!documents.runEditorCommand(id, editingCommands[name])) {
      setNotice('编辑器尚未挂载，请在正文区域聚焦后重试。');
    }
  }, [setNotice]);
  const startWorkspaceSearch = useCallback((draft: WorkspaceSearchDraft) => {
    const dirtyDocuments = documents.getSnapshot().documents.flatMap(summary => {
      const managed = documents.getDocument(summary.id);
      if (!managed?.summary.dirty || !managed.source) return [];
      return [{
        id: summary.id,
        ref: managed.source.ref,
        displayName: summary.title,
        displayPath: summary.displayPath ?? summary.title,
        text: managed.state.doc.toString(),
        version: summary.version,
      }];
    });
    void workspaceSearch.start({
      requestId: crypto.randomUUID(),
      roots: draft.roots,
      query: draft.query,
      include: draft.include,
      exclude: draft.exclude,
      respectGitignore: draft.respectGitignore,
      followDirectoryLinks: draft.followDirectoryLinks,
      includeHidden: draft.includeHidden,
      maxMatches: 10_000,
    }, dirtyDocuments);
  }, [workspaceSearch]);

  const openWorkspaceSearchResult = useCallback(async (
    file: SearchFileResult,
    match: SearchMatch,
  ) => {
    const errorMessage = await openOne(file.ref, 'pinned', false);
    if (errorMessage) {
      setError(errorMessage);
      return;
    }
    const id = documents.getSnapshot().activeId;
    const managed = id ? documents.getDocument(id) : undefined;
    if (!managed) return;
    if (file.encoding !== 'buffer' && managed.source?.metadata.diskRevision !== file.revision) {
      setNotice('文件在搜索后已变化，旧位置未跳转；请重新搜索后再定位。');
      return;
    }
    goToPosition({ line: match.line, column: match.column });
    setWorkspaceSearchOpen(false);
  }, [goToPosition, openOne, setNotice]);

  const previewWorkspaceReplace = useCallback(async (draft: WorkspaceSearchDraft, replacement: string) => {
    setAutoFocus(false);
    setReplacementBusy(true);
    setReplacementError(null);
    setReplaceOutcome(null);
    setRollbackOutcome(null);
    setReplacementCommitUnknown(false);
    const dirtyPaths = documents.getSnapshot().documents.flatMap(summary => {
      const managed = documents.getDocument(summary.id);
      return summary.dirty && managed?.source ? [managed.source.metadata.displayPath] : [];
    });
    try {
      const result = await replacementBridge.preview({
        requestId: crypto.randomUUID(),
        roots: draft.roots,
        pattern: draft.query.pattern,
        replacement,
        isRegex: draft.query.isRegex,
        isCaseSensitive: draft.query.isCaseSensitive,
        isWholeWord: draft.query.isWholeWord,
        include: draft.include,
        exclude: draft.exclude,
        respectGitignore: draft.respectGitignore,
        followDirectoryLinks: draft.followDirectoryLinks,
        includeHidden: draft.includeHidden,
        dirtyPaths,
      });
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
      setReplacementPlan(result.value);
      setWorkspaceSearchOpen(false);
    } finally {
      setReplacementBusy(false);
    }
  }, []);

  const commitReplacement = useCallback(async (selected: readonly FileRef[]) => {
    const plan = replacementPlan;
    if (!plan || replacementBusy) return;
    setReplacementBusy(true);
    setReplacementError(null);
    setReplacementCommitUnknown(false);
    try {
      const result = await replacementBridge.commit({
        planId: plan.planId,
        confirmationToken: plan.confirmationToken,
        selected: [...selected],
      });
      if (!result.ok) {
        setReplacementError(result.error.code === 'IPC_UNAVAILABLE'
          ? '提交回执未知，暂时不能把任何文件标为成功。'
          : result.error.message);
        setReplacementCommitUnknown(result.error.code === 'IPC_UNAVAILABLE');
      } else {
        setReplaceOutcome(result.value);
      }
      await externalChanges.checkAll();
    } finally {
      setReplacementBusy(false);
    }
  }, [replacementBusy, replacementPlan]);

  const rollbackReplacement = useCallback(async () => {
    const batchId = replaceOutcome?.batchId ?? replacementPlan?.planId;
    if (!batchId || replacementBusy) return;
    setReplacementBusy(true);
    setReplacementError(null);
    try {
      const result = await replacementBridge.rollback({ batchId });
      if (!result.ok) {
        setReplacementError(result.error.message);
      } else {
        setRollbackOutcome(result.value);
        setReplacementCommitUnknown(false);
      }
      await externalChanges.checkAll();
    } finally {
      setReplacementBusy(false);
    }
  }, [replacementBusy, replacementPlan, replaceOutcome]);

  const closeReplacement = useCallback(() => {
    if (replacementBusy) return;
    setReplacementPlan(null);
    setReplacementError(null);
    setReplaceOutcome(null);
    setRollbackOutcome(null);
    setReplacementCommitUnknown(false);
    setAutoFocus(true);
  }, [replacementBusy]);

  const commandActions = useMemo<AppCommandActions>(() => ({
    'file.new': newFile, 'file.open': openFile, 'workspace.open': openFolder, 'file.save': saveCurrent,
    'file.saveAs': () => saveDestination(), 'file.saveCopy': () => saveDestination('copy'),
    'file.saveAll': async () => { await saveAll.run(); },
    'file.close': async () => { const id = documents.getSnapshot().activeId; if (id) await requestClose(id); },
    'editor.find': openFind,
    'search.workspace': () => setWorkspaceSearchOpen(true),
    'editor.toggleComment': () => runEditingCommand('toggleComment'),
    'editor.toggleBlockComment': () => runEditingCommand('toggleBlockComment'),
    'editor.moveLineUp': () => runEditingCommand('moveLineUp'),
    'editor.moveLineDown': () => runEditingCommand('moveLineDown'),
    'editor.copyLineUp': () => runEditingCommand('copyLineUp'),
    'editor.copyLineDown': () => runEditingCommand('copyLineDown'),
    'editor.insertBlankLine': () => runEditingCommand('insertBlankLine'),
    'editor.complete': () => runEditingCommand('startCompletion'),
    'editor.selectNextOccurrence': () => runEditingCommand('selectNextOccurrence'),
    'editor.selectAllOccurrences': () => runEditingCommand('selectAllOccurrences'),
    'editor.toggleFold': () => runEditingCommand('toggleFold'),
    'navigation.goToLine': () => setGoToOpen(true),
    'navigation.back': () => { navigateBack(); },
    'navigation.forward': () => { navigateForward(); },
    'navigation.outline': () => setOutlineOpen(true),
    'tabs.pin': () => { const id = documents.getSnapshot().activeId; if (id) tabs.pin(id); },
    'tabs.split': () => { const id = documents.getSnapshot().activeId; if (id) tabs.split(id); },
    'tabs.closeSplit': () => tabs.closeSplit(),
    'tabs.reopen': async () => {
      const result = await tabs.reopenLastClosed();
      if (result && !result.ok) setError(result.error.message);
    },
    'tabs.closeOthers': async () => {
      const id = documents.getSnapshot().activeId;
      if (id) await requestCloseBatch(tabs.closeCandidates('others', id));
    },
    'tabs.closeRight': async () => {
      const id = documents.getSnapshot().activeId;
      if (id) await requestCloseBatch(tabs.closeCandidates('right', id));
    },
    'tabs.closeClean': async () => requestCloseBatch(tabs.closeCandidates('clean')),
    'editor.fontIncrease': () => zoomEditor('in'), 'editor.fontDecrease': () => zoomEditor('out'),
    'editor.fontReset': () => zoomEditor('reset'),
    'view.sidebar': () => setSidebarOpen(open => !open),
    'view.theme': () => settings.setSession('theme', dark ? 'light' : 'dark'), 'settings.open': openSettings,
    'commands.open': () => openPalette('commands'), 'files.quickOpen': () => openPalette('files'),
  }), [newFile, openFile, openFolder, saveCurrent, saveDestination, requestClose, requestCloseBatch,
    openFind, runEditingCommand, navigateBack, navigateForward, openPalette, openSettings, dark, zoomEditor,
    setGoToOpen, setOutlineOpen, setSidebarOpen, setWorkspaceSearchOpen]);

  const executeCommand = useCallback(async (id: string, targetId?: DocumentId) => {
    const actions = targetId ? { ...commandActions, 'file.close': () => requestClose(targetId), 'tabs.pin': () => tabs.pin(targetId) } : commandActions;
    const result = await commands.execute(id, getCommandState(targetId), actions);
    if (!result.ok) setError(result.reason);
  }, [commands, getCommandState, commandActions, requestClose]);

  const quickFiles = useMemo(() => paletteMode === 'files' ? quickCandidates(snapshot.documents.map(document => ({
    id: document.id, title: document.title, displayPath: document.displayPath, ref: documents.getDocument(document.id)?.source?.ref ?? null,
  })), workspaceState) : null, [paletteMode, snapshot.documents, workspaceState]);
  const currentOutline = (() => {
    const managed = current ? documents.getDocument(current.id) : undefined;
    if (!managed) return [];
    return localOutline(managed.summary.languageId, managed.state.doc.sliceString(0, 2_000_000));
  })();

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
      if (startupPending || event.repeat || window.document.querySelector('dialog[open]')) return;
      void executeCommand(id);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [commands, executeCommand, startupPending]);

  function selectTab(id: DocumentId) {
    setAutoFocus(false);
    const groups = tabs.getSnapshot();
    if (groups.secondaryId && groups.focusedGroup === 'secondary') tabs.focusSecondary(id);
    else tabs.focusPrimary(id);
  }

  if (startupPending) return <main className="startup-screen" role="status" aria-live="polite">
    <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-mark">
      <path d="M5 21 19 3C9 2 3 8 7 16c7 2 13-3 12-13M10 14l6 0M13 10V6" />
    </svg>
    <p>正在恢复本地会话…</p>
  </main>;

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
        <RootList busy={busy || savingCount > 0 || batchBusy || closingCount > 0}
          workspaceFile={workspaceFile.document?.displayPath ?? null}
          onAdd={() => void addRoot()} onRemove={root => void removeRoot(root)}
          onOpenFile={() => void workspaceFile.open().then(error => { if (error) setError(error); })}
            onSaveFile={() => void workspaceFile.save().then(error => { if (error) setError(error); })}
            onRenamed={renamed => { void applyPathMappings(renamed); }} />
        <FavoriteList entries={favorites.entries} problem={favorites.problem} availableGrantIds={sessionState.availableGrantIds}
          busy={busy || savingCount > 0 || batchBusy || closingCount > 0} canAddFile={!!currentSource} canAddRoot={!!workspaceState.root}
          onAddFile={favorites.addFile} onAddRoot={favorites.addRoot} onOpen={favorites.open} onRepair={favorites.repair}
          onChange={favorites.change} onClear={favorites.clear} />
        <Explorer currentReference={currentReference} onOpen={(reference, intent) => void openTreeFile(reference, intent ?? 'preview')}
          onTrash={setTrashEntry} mutationBlocked={busy || savingCount > 0 || batchBusy || closingCount > 0}
          onRenamed={renamed => {
            void applyPathMappings(renamed);
          }} />
      </div>}
      status={<><span>{closingCount > 0 || current?.closing ? '正在关闭…' : batchBusy ? '正在全部保存…' : savingCount > 0 ? '正在保存…' : busy ? '正在打开…' : current ? current.readOnlyReason ? '只读' : current.dirty ? '未保存修改' : current.displayPath ? '未修改' : '未命名' : '就绪'}</span>{current && <><span role="group" aria-label="光标与字数" aria-live="off"><EditorStatus registry={documents} id={current.id} summary={current} /></span><span aria-label="编辑字号">{settingsState.settings.fontSize}px</span></>}<span className="status-end">{current ? `${current.format.encoding.toUpperCase()}${current.format.bom === 'none' ? '' : ' BOM'} · ${current.format.lineEnding.toUpperCase()}` : '轻羽 FeatherPad'}</span></>}
    >
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭提示</button></div>}
      {notice && <div className="notice error-notice" aria-live="polite"><span>{notice}</span><button onClick={() => setNotice(null)}>关闭提示</button></div>}
      {tabState.warning && <p className="notice" role="alert">{tabState.warning}</p>}
      {commandState.warning && <p className="notice" role="alert">{commandState.warning}</p>}
      {workspaceSearchOpen && <WorkspaceSearchPanel store={workspaceSearch} roots={workspaceState.roots}
        onSearch={startWorkspaceSearch} onOpen={(file, match) => void openWorkspaceSearchResult(file, match)}
        onPreviewReplace={(draft, replacement) => void previewWorkspaceReplace(draft, replacement)}
        onClose={() => setWorkspaceSearchOpen(false)} />}
      {replacementPlan && <ReplacePreviewDialog plan={replacementPlan} busy={replacementBusy}
        error={replacementError} outcome={replaceOutcome} rollback={rollbackOutcome}
        commitUnknown={replacementCommitUnknown}
        onCommit={selection => void commitReplacement(selection)} onRollback={() => void rollbackReplacement()}
        onClose={closeReplacement} />}
      <RecoveryPanel candidates={saveTransactions} onOpen={openTransactionCopy}
        inventory={recoveryInventory} inventoryError={recoveryInventoryError}
        activeRecovery={snapshot.documents.filter(document => document.dirty).map(document => ({
          id: document.id, title: document.displayPath ?? document.title, version: document.version,
        }))}
        onRefresh={refreshRecoveryInventory} onCleanupInactive={cleanupInactiveRecovery}
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
          <button className="plain-button" {...commandProps('search.workspace')} onClick={() => void executeCommand('search.workspace')}>目录搜索</button>
          <button id="save-all-button" className="plain-button" {...commandProps('file.saveAll')} onClick={() => void executeCommand('file.saveAll')}>全部保存</button>
          <button className="plain-button" {...commandProps('file.saveAs')} onClick={() => void executeCommand('file.saveAs')}>另存为</button>
          <button className="plain-button" {...commandProps('file.saveCopy')} onClick={() => void executeCommand('file.saveCopy')}>保存副本</button>
          <EncodingMenu key={current.id} registry={documents} summary={current}
            blocked={busy || savingCount > 0 || batchBusy || closingCount > 0 || exitState.phase !== 'idle'} onMessage={setNotice} />
          <button type="button" className="plain-button tab-pin-control" {...commandProps('tabs.pin')} onClick={() => void executeCommand('tabs.pin')}>{tabState.previewId === current.id ? '固定标签' : '已固定'}</button>
          <button type="button" className="plain-button" {...commandProps('tabs.split')}
            onClick={() => void executeCommand('tabs.split')}>向右拆分</button>
          {secondaryEditorId && <button type="button" className="plain-button" {...commandProps('tabs.closeSplit')}
            onClick={() => void executeCommand('tabs.closeSplit')}>关闭拆分</button>}
          {tabState.recentlyClosed.length > 0 && <button type="button" className="plain-button" {...commandProps('tabs.reopen')}
            onClick={() => void executeCommand('tabs.reopen')}>重新打开关闭的标签</button>}
          {snapshot.documents.length > 1 && <button type="button" className="plain-button" {...commandProps('tabs.closeOthers')}
            onClick={() => void executeCommand('tabs.closeOthers')}>关闭其他</button>}
          {snapshot.documents.length > 1 && <button type="button" className="plain-button" {...commandProps('tabs.closeRight')}
            onClick={() => void executeCommand('tabs.closeRight')}>关闭右侧</button>}
          {snapshot.documents.some(document => !document.dirty) && <button type="button" className="plain-button" {...commandProps('tabs.closeClean')}
            onClick={() => void executeCommand('tabs.closeClean')}>关闭已保存</button>}
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
        <Breadcrumbs displayPath={current.displayPath} language={languageLabel(current.languageId)}>
          <button type="button" className="plain-button breadcrumb-action" {...commandProps('navigation.back')}
            onClick={() => void executeCommand('navigation.back')}>后退</button>
          <button type="button" className="plain-button breadcrumb-action" {...commandProps('navigation.forward')}
            onClick={() => void executeCommand('navigation.forward')}>前进</button>
          <button type="button" className="plain-button breadcrumb-action" {...commandProps('navigation.goToLine')}
            onClick={() => void executeCommand('navigation.goToLine')}>行:列</button>
          <button type="button" className="plain-button breadcrumb-action" {...commandProps('navigation.outline')}
            onClick={() => void executeCommand('navigation.outline')}>大纲{currentOutline.length > 0 ? ` (${currentOutline.length})` : ''}</button>
        </Breadcrumbs>
        <FindBar registry={documents} id={current.id} version={current.version} readOnlyReason={current.readOnlyReason}
          request={findRequest?.id === current.id ? findRequest : null} open={findOpen} onClose={() => setFindOpen(false)} />
        <SaveAllResults />
        <AutoSaveStatus id={current.id} />
        <TabStrip documents={snapshot.documents} activeId={snapshot.activeId} previewId={tabState.previewId}
          busy={busy || savingCount > 0 || batchBusy || closingCount > 0} onSelect={selectTab}
          onPin={id => { if (tabs.getSnapshot().previewId === id) void executeCommand('tabs.pin', id); }}
          onClose={id => void executeCommand('file.close', id)} onReorder={ids => documents.reorder(ids)} />
        <ConflictBanner key={`conflict-${snapshot.activeId}`} id={snapshot.activeId} registry={documents} coordinator={externalChanges} saving={saves} />
        <div className={`editor-groups ${secondaryEditorId ? 'editor-groups-split' : ''}`}>
          <div className={`editor-group ${tabState.focusedGroup === 'primary' ? 'editor-group-focused' : ''}`}
            onMouseDown={() => { if (primaryEditorId) tabs.focusPrimary(primaryEditorId); }}>
            {secondaryEditorId && <div className="editor-group-label">主编辑组</div>}
            {primaryEditorId && <DocumentContent key={`primary-${primaryEditorId}`} registry={documents}
              id={primaryEditorId} group="primary" dark={dark} allowHtml={settingsState.settings.markdownAllowHtml} autoFocus={autoFocus && tabState.focusedGroup === 'primary'}
              onActivate={() => tabs.focusPrimary(primaryEditorId)} onOpenFile={reference => void openTreeFile(reference, 'pinned')} />}
          </div>
          {secondaryEditorId && <div className={`editor-group ${tabState.focusedGroup === 'secondary' ? 'editor-group-focused' : ''}`}
            onMouseDown={() => tabs.focusSecondary(secondaryEditorId)}>
            <div className="editor-group-label">第二编辑组<button type="button" className="plain-button"
              onClick={() => tabs.closeSplit()}>关闭</button></div>
            <DocumentContent key={`secondary-${secondaryEditorId}`} registry={documents}
              id={secondaryEditorId} group="secondary" dark={dark} allowHtml={settingsState.settings.markdownAllowHtml} autoFocus={autoFocus && tabState.focusedGroup === 'secondary'}
              onActivate={() => tabs.focusSecondary(secondaryEditorId)} onOpenFile={reference => void openTreeFile(reference, 'pinned')} />
          </div>}
        </div>
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
        onBind={(id, value) => commands.setBinding(id, value)} onResetBindings={() => commands.resetBindings()}
        onImportBindings={text => commands.importBindings(text)} onExportBindings={() => commands.exportBindings()} />}
      {goToOpen && current && (() => {
        const managed = documents.getDocument(current.id);
        if (!managed) return null;
        return <GoToLineDialog current={lineColumnAt(managed.state, managed.state.selection.main.head)}
          onGo={goToPosition} onClose={() => {
            setGoToOpen(false);
            requestAnimationFrame(() => documents.focus(current.id));
          }} />;
      })()}
      {outlineOpen && current && <OutlineDialog items={currentOutline} onSelect={item => {
        const managed = documents.getDocument(current.id);
        if (managed) goToPosition(lineColumnAt(managed.state, item.offset));
      }} onClose={() => {
        setOutlineOpen(false);
        requestAnimationFrame(() => documents.focus(current.id));
      }} />}
      {closeTarget && <CloseDialog key={closeTarget.id} target={closeTarget} registry={documents} tabs={tabs}
        onClosed={() => {
          const queued = closeQueue;
          setCloseQueue([]);
          setCloseTarget(null);
          if (queued.length > 0) void requestCloseBatch(queued);
          else focusAfterClose();
        }}
        onCancel={() => {
          setCloseQueue([]);
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

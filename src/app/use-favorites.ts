import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { files } from '../bridge/files';
import { settings } from '../features/desktop/settings';
import { session } from '../features/desktop/session';
import { documents } from '../features/editor/documents';
import { favoritesSetting, mutateFavorites, readFavorites, type Favorite, type FavoriteAction } from '../features/workspace/favorites';
import { recentFileCandidate, recentWorkspaceCandidate } from '../features/workspace/recent';
import { workspace } from '../features/workspace/store';
import type { WorkspaceRoots } from '../features/workspace/roots';
import type { FileRef } from '../shared/contracts/files';

export function useFavorites(roots: WorkspaceRoots, openFile: (ref: FileRef) => Promise<string | null>,
  openedRoot: (ref: FileRef, title: string) => Promise<unknown>) {
  const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot);
  const parsed = useMemo(() => {
    try { return { entries: readFavorites(snapshot.user[favoritesSetting]), problem: null }; }
    catch { return { entries: [], problem: '收藏格式无效或超出容量。' }; }
  }, [snapshot.user]);
  const change = useCallback(async (action: FavoriteAction): Promise<string | null> => {
    const result = await settings.updatePersistedValue(favoritesSetting, current => mutateFavorites(current, action));
    if (!result.ok) return result.error.message;
    // Persist grants for referenced current roots/files, independently of history.
    const persisted = await session.flush();
    return persisted.ok ? null : `收藏已保存，授权会话未落盘：${persisted.error.message}`;
  }, []);
  const addFile = useCallback(async () => {
    const id = documents.getSnapshot().activeId, source = id ? documents.getDocument(id)?.source : null;
    if (!source) return '当前没有已命名文件。';
    return change({ kind: 'add', candidate: recentFileCandidate(source) });
  }, [change]);
  const addRoot = useCallback(async () => {
    const root = workspace.getSnapshot().root;
    if (!root) return '当前没有工作区根。';
    return change({ kind: 'add', candidate: { ...recentWorkspaceCandidate(root.grant, root.displayPath ?? root.displayName),
      title: root.displayName, canonicalIdentity: root.canonicalIdentity ?? `grant:${root.grant.grantId}` } });
  }, [change]);
  const open = useCallback(async (entry: Favorite) => {
    if (entry.kind === 'file') return openFile(entry.ref);
    const result = await roots.openRoot({ grant: entry.ref, displayName: entry.name }, true);
    if (!result.ok) return result.error.message;
    await openedRoot(result.value.grant, result.value.displayName); return null;
  }, [roots, openFile, openedRoot]);
  const repair = useCallback(async (entry: Favorite) => {
    if (entry.kind === 'workspace') {
      const result = await roots.chooseRoot(true);
      if (!result.ok) return result.error.message;
      if (!result.value) return '已取消重新选择，原收藏保留。';
      const root = result.value;
      await openedRoot(root.grant, root.displayName);
      return change({ kind: 'rebind', id: entry.id, candidate: { ...recentWorkspaceCandidate(root.grant, root.displayPath ?? root.displayName),
        title: root.displayName, canonicalIdentity: root.canonicalIdentity ?? `grant:${root.grant.grantId}` } });
    }
    const selected = await files.chooseFiles(false);
    if (!selected.ok) return selected.error.message;
    const ref = selected.value.grants[0];
    if (!ref) return '已取消重新选择，原收藏保留。';
    const error = await openFile(ref); if (error) return error;
    const id = documents.getSnapshot().activeId, source = id ? documents.getDocument(id)?.source : null;
    if (!source) return '未找到已打开文件，原收藏保留。';
    return change({ kind: 'rebind', id: entry.id, candidate: recentFileCandidate(source) });
  }, [roots, openFile, openedRoot, change]);
  const clear = useCallback(() => change({ kind: 'clear' }), [change]);
  return { ...parsed, change, addFile, addRoot, open, repair, clear };
}

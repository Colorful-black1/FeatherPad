import { useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import type { DirectoryEntry, FileRef } from '../../shared/contracts/files';
import { workspace, type WorkspaceSnapshot, type WorkspaceStore } from './store';

interface ExplorerProps {
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  store?: WorkspaceStore;
}

interface DirectoryContentsProps {
  reference: FileRef;
  depth: number;
  parentKey: string | null;
  snapshot: WorkspaceSnapshot;
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  store: WorkspaceStore;
}

function EntryIcon({ entry }: { entry: DirectoryEntry }) {
  if (entry.kind === 'directory') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" /></svg>;
  }
  if (entry.kind === 'junction' || entry.kind === 'symlink') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H6a4 4 0 0 0 0 8h3M15 17h3a4 4 0 0 0 0-8h-3M8 12h8" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6ZM14 3v5h5" /></svg>;
}

function EntryRow({
  entry, depth, parentKey, snapshot, currentReference, onOpen, store,
}: {
  entry: DirectoryEntry;
  depth: number;
  parentKey: string | null;
  snapshot: WorkspaceSnapshot;
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  store: WorkspaceStore;
}) {
  const expandable = entry.kind === 'directory';
  const expanded = expandable && snapshot.expanded[entry.ref.relativePath] === true;
  const current = currentReference?.grantId === entry.ref.grantId
    && currentReference.relativePath === entry.ref.relativePath;
  const selected = snapshot.selectedPath === entry.ref.relativePath;

  function activate() {
    store.select(entry);
    if (expandable) store.toggleDirectory(entry);
    else onOpen(entry.ref);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tree = event.currentTarget.closest<HTMLElement>('[data-workspace-tree]');
    if (!tree) return;
    const rows = [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')]
      .filter(row => !row.disabled);
    const index = rows.indexOf(event.currentTarget);
    event.preventDefault();
    if (event.key === 'ArrowRight' && expandable && !expanded) {
      store.toggleDirectory(entry);
      return;
    }
    if (event.key === 'ArrowRight' && expanded && rows[index + 1]?.dataset.treeParent === entry.ref.relativePath) {
      rows[index + 1]?.focus();
      return;
    }
    if (event.key === 'ArrowLeft' && expanded) {
      store.collapseDirectory(entry);
      return;
    }
    if (event.key === 'ArrowLeft' && parentKey !== null) {
      rows.find(row => row.dataset.treeKey === parentKey)?.focus();
      return;
    }
    const target = event.key === 'Home' ? rows[0]
      : event.key === 'End' ? rows.at(-1)
        : event.key === 'ArrowUp' ? rows[Math.max(0, index - 1)]
          : rows[Math.min(rows.length - 1, index + 1)];
    target?.focus();
  }

  return <>
    <button
      type="button"
      className="tree-row"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      aria-current={current ? 'page' : undefined}
      title={entry.name}
      data-tree-key={entry.ref.relativePath}
      data-tree-parent={parentKey ?? ''}
      style={{ '--tree-depth': depth } as CSSProperties}
      onClick={activate}
      onKeyDown={navigate}
    >
      <span className={`tree-chevron ${expandable ? '' : 'tree-chevron-empty'}`} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="tree-icon"><EntryIcon entry={entry} /></span>
      <span className="tree-name">{entry.name}</span>
      {entry.isReadOnly && <span className="tree-badge">只读</span>}
      {(entry.kind === 'junction' || entry.kind === 'symlink') && <span className="tree-badge">链接</span>}
    </button>
    {expanded && <DirectoryContents
      reference={entry.ref}
      depth={depth + 1}
      parentKey={entry.ref.relativePath}
      snapshot={snapshot}
      currentReference={currentReference}
      onOpen={onOpen}
      store={store}
    />}
  </>;
}

function DirectoryContents({
  reference, depth, parentKey, snapshot, currentReference, onOpen, store,
}: DirectoryContentsProps) {
  const record = snapshot.records[reference.relativePath];
  if (!record || (!record.loaded && !record.loading && !record.error)) return null;
  return <div role="group" className="tree-group">
    {record.loading && record.items.length === 0 && <p className="tree-state">正在读取…</p>}
    {record.error && <div className="tree-state tree-error" role="alert">
      <span>{record.error}</span>
      <button type="button" onClick={() => store.refresh(reference)}>重试</button>
    </div>}
    {record.items.map(entry => <div key={entry.id} role="none">
      <EntryRow
        entry={entry}
        depth={depth}
        parentKey={parentKey}
        snapshot={snapshot}
        currentReference={currentReference}
        onOpen={onOpen}
        store={store}
      />
    </div>)}
    {record.loaded && record.items.length === 0 && <p className="tree-state">此文件夹为空</p>}
    {record.nextCursor && <button
      type="button"
      className="tree-load-more"
      disabled={record.loading}
      onClick={() => store.loadMore(reference)}
    >{record.loading ? '正在加载…' : '加载更多'}</button>}
  </div>;
}

export function Explorer({ currentReference, onOpen, store = workspace }: ExplorerProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const root = snapshot.root;
  const currentInRoot = root && currentReference?.grantId === root.grant.grantId;

  return <section className="workspace-explorer" aria-label="文件树">
    <div className="explorer-heading">
      <h2 className="sidebar-title">资源管理器</h2>
      <div className="explorer-actions">
        {root && <button type="button" className="icon-button compact" onClick={() => store.refresh()} aria-label="刷新目录树" title="刷新">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
        </button>}
        {root && <button type="button" className="icon-button compact" disabled={!currentInRoot}
          onClick={() => { if (currentReference) void store.locate(currentReference); }}
          aria-label="定位当前文件" title="定位当前文件">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
        </button>}
      </div>
    </div>
    {!root && <p className="sidebar-empty">尚未打开文件夹</p>}
    {root && <>
      <label className="explorer-filter">
        <input type="checkbox" checked={snapshot.showHidden} onChange={event => store.setShowHidden(event.target.checked)} />
        显示隐藏项
      </label>
      <div className="tree-root-label">{root.displayName}</div>
      {snapshot.rootError && <p className="tree-state tree-error" role="alert">{snapshot.rootError}</p>}
      <div className="tree" role="tree" aria-label={`${root.displayName} 文件树`} data-workspace-tree>
        <DirectoryContents
          reference={root.grant}
          depth={0}
          parentKey={null}
          snapshot={snapshot}
          currentReference={currentReference}
          onOpen={onOpen}
          store={store}
        />
      </div>
    </>}
  </section>;
}

import { useEffect, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import type { DirectoryEntry, FileRef, RenamedDocument } from '../../shared/contracts/files';
import { EntryInput } from './EntryInput';
import { creationParent, findDirectoryEntry } from './file-actions';
import { workspace, type WorkspaceSnapshot, type WorkspaceStore } from './store';

interface ExplorerProps {
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  onRenamed?: ((documents: readonly RenamedDocument[]) => void) | undefined;
  store?: WorkspaceStore;
}

interface EditingEntry {
  mode: 'create-file' | 'create-directory' | 'rename';
  parent: FileRef;
  entry?: DirectoryEntry;
}

interface DirectoryContentsProps {
  reference: FileRef;
  depth: number;
  parentKey: string | null;
  snapshot: WorkspaceSnapshot;
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  onRenamed?: ((documents: readonly RenamedDocument[]) => void) | undefined;
  editing: EditingEntry | null;
  beginEditing: (editing: EditingEntry) => void;
  finishEditing: (focusPath?: string) => void;
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
  entry, depth, parentKey, snapshot, currentReference, onOpen, editing, beginEditing,
  finishEditing, onRenamed, store,
}: {
  entry: DirectoryEntry;
  depth: number;
  parentKey: string | null;
  snapshot: WorkspaceSnapshot;
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef) => void;
  onRenamed?: ((documents: readonly RenamedDocument[]) => void) | undefined;
  editing: EditingEntry | null;
  beginEditing: (editing: EditingEntry) => void;
  finishEditing: (focusPath?: string) => void;
  store: WorkspaceStore;
}) {
  const expandable = entry.kind === 'directory';
  const expanded = expandable && snapshot.expanded[entry.ref.relativePath] === true;
  const current = currentReference?.grantId === entry.ref.grantId
    && currentReference.relativePath === entry.ref.relativePath;
  const selected = snapshot.selectedPath === entry.ref.relativePath;
  const renaming = editing?.mode === 'rename'
    && editing.entry?.ref.relativePath === entry.ref.relativePath;

  function activate() {
    store.select(entry);
    if (expandable) store.toggleDirectory(entry);
    else onOpen(entry.ref);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'F2' && !expandable && !['junction', 'symlink'].includes(entry.kind)) {
      event.preventDefault();
      beginEditing({ mode: 'rename', parent: entry.ref, entry });
      return;
    }
    if (event.key === 'F2' && expandable) {
      event.preventDefault();
      beginEditing({ mode: 'rename', parent: entry.ref, entry });
      return;
    }
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
    {renaming ? <EntryInput
      depth={depth}
      mode="rename"
      initialValue={entry.name}
      onSubmit={async name => {
        const result = await store.renameEntry(entry, name);
        if (!result.ok) return result.error.message;
        onRenamed?.(result.value.renamedDocuments);
        finishEditing(result.value.entry.ref.relativePath);
        return null;
      }}
      onCancel={() => finishEditing(entry.ref.relativePath)}
    /> : <button
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
    </button>}
    {expanded && <DirectoryContents
      reference={entry.ref}
      depth={depth + 1}
      parentKey={entry.ref.relativePath}
      snapshot={snapshot}
      currentReference={currentReference}
      onOpen={onOpen}
      onRenamed={onRenamed}
      editing={editing}
      beginEditing={beginEditing}
      finishEditing={finishEditing}
      store={store}
    />}
  </>;
}

function DirectoryContents({
  reference, depth, parentKey, snapshot, currentReference, onOpen, editing, beginEditing,
  finishEditing, onRenamed, store,
}: DirectoryContentsProps) {
  const record = snapshot.records[reference.relativePath];
  const creating = editing && editing.mode !== 'rename'
    && editing.parent.relativePath === reference.relativePath;
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
        onRenamed={onRenamed}
        editing={editing}
        beginEditing={beginEditing}
        finishEditing={finishEditing}
        store={store}
      />
    </div>)}
    {creating && <EntryInput
      depth={depth}
      mode={editing.mode}
      onSubmit={async name => {
        const result = await store.createEntry(
          editing.parent,
          name,
          editing.mode === 'create-directory' ? 'directory' : 'file',
        );
        if (!result.ok) return result.error.message;
        finishEditing(result.value.ref.relativePath);
        if (result.value.kind === 'file') onOpen(result.value.ref);
        return null;
      }}
      onCancel={() => finishEditing(reference.relativePath)}
    />}
    {record.loaded && record.items.length === 0 && <p className="tree-state">此文件夹为空</p>}
    {record.nextCursor && <button
      type="button"
      className="tree-load-more"
      disabled={record.loading}
      onClick={() => store.loadMore(reference)}
    >{record.loading ? '正在加载…' : '加载更多'}</button>}
  </div>;
}

export function Explorer({ currentReference, onOpen, onRenamed, store = workspace }: ExplorerProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [editing, setEditing] = useState<EditingEntry | null>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const root = snapshot.root;
  const currentInRoot = root && currentReference?.grantId === root.grant.grantId;
  const selectedEntry = snapshot.selectedPath
    ? findDirectoryEntry(snapshot, snapshot.selectedPath)
    : null;
  const canRename = selectedEntry
    && !['junction', 'symlink'].includes(selectedEntry.kind);
  const createParent = creationParent(snapshot);
  const createRecord = createParent ? snapshot.records[createParent.relativePath] : null;
  const canCreate = Boolean(createParent && createRecord?.loaded
    && !createRecord.loading && !createRecord.error);

  useEffect(() => {
    if (!focusPath) return;
    const frame = requestAnimationFrame(() => {
      const tree = document.querySelector<HTMLElement>('[data-workspace-tree]');
      const row = [...(tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])]
        .find(candidate => candidate.dataset.treeKey === focusPath);
      row?.focus();
      setFocusPath(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusPath, snapshot]);

  function beginEditing(next: EditingEntry) {
    setEditing(next);
  }

  function finishEditing(nextFocus?: string) {
    setEditing(null);
    if (nextFocus) setFocusPath(nextFocus);
  }

  function beginCreate(mode: 'create-file' | 'create-directory') {
    const parent = createParent;
    if (!canCreate || !parent) return;
    if (parent.relativePath) {
      const entry = findDirectoryEntry(snapshot, parent.relativePath);
      if (entry?.kind === 'directory' && !snapshot.expanded[parent.relativePath]) {
        store.toggleDirectory(entry);
      }
    }
    setEditing({ mode, parent });
  }

  return <section className="workspace-explorer" aria-label="文件树">
    <div className="explorer-heading">
      <h2 className="sidebar-title">资源管理器</h2>
      <div className="explorer-actions">
        {root && <button type="button" className="icon-button compact" disabled={!canCreate || !!editing}
          onClick={() => beginCreate('create-file')} aria-label="新建文件" title="新建文件">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6ZM14 3v5h5M12 11v6M9 14h6" /></svg>
        </button>}
        {root && <button type="button" className="icon-button compact" disabled={!canCreate || !!editing}
          onClick={() => beginCreate('create-directory')} aria-label="新建文件夹" title="新建文件夹">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3ZM3 9h18M12 12v5M9.5 14.5h5" /></svg>
        </button>}
        {root && <button type="button" className="icon-button compact" disabled={!canRename || !!editing}
          onClick={() => { if (selectedEntry) setEditing({ mode: 'rename', parent: selectedEntry.ref, entry: selectedEntry }); }}
          aria-label="重命名选中项" title="重命名（F2）">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-1 5 5-1L19 9l-4-4L4 16ZM13 7l4 4" /></svg>
        </button>}
        {root && <button type="button" className="icon-button compact" disabled={!!editing}
          onClick={() => store.refresh()} aria-label="刷新目录树" title="刷新">
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
          onRenamed={onRenamed}
          editing={editing}
          beginEditing={beginEditing}
          finishEditing={finishEditing}
          store={store}
        />
      </div>
    </>}
  </section>;
}

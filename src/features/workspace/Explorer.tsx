import { useEffect, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { DirectoryEntry, FileRef, RenamedDocument } from '../../shared/contracts/files';
import { EntryInput } from './EntryInput';
import { creationParent, findDirectoryEntry } from './file-actions';
import { workspace, type WorkspaceSnapshot, type WorkspaceStore } from './store';
import { FilterRules } from './FilterRules';
import { dragPayload, parseDragPayload, transferMode, workspaceDragType, startWorkspaceDrag, endWorkspaceDrag, highlightDropTarget, clearDropTarget } from './drag-drop';
import { useFileTransfer } from './use-file-transfer';
import { ExplorerContextMenu, type ExplorerMenuTarget } from './ExplorerContextMenu';

interface ExplorerProps {
  currentReference: FileRef | undefined;
  onOpen: (reference: FileRef, intent?: 'preview' | 'pinned') => void;
  onRenamed?: ((documents: readonly RenamedDocument[]) => void) | undefined;
  onTrash?: ((entry: DirectoryEntry) => void) | undefined;
  onReveal?: ((entry: DirectoryEntry) => void) | undefined;
  mutationBlocked?: boolean;
  onNewText?: () => void;
  onChooseFile?: () => void;
  onChooseFolder?: () => void;
  onManageWorkspace?: () => void;
  openEditors?: ReactNode;
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
  onOpen: (reference: FileRef, intent?: 'preview' | 'pinned') => void;
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
  onOpen: (reference: FileRef, intent?: 'preview' | 'pinned') => void;
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
  const transferable = !['junction', 'symlink'].includes(entry.kind);
  const transfer = useFileTransfer(store, onRenamed);

  async function transferTo(event: DragEvent<HTMLElement>) {
    if (!expandable) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropTarget(event.currentTarget);
    const payload = parseDragPayload(event.dataTransfer.getData(workspaceDragType));
    if (!payload || payload.grantId !== entry.ref.grantId) return;
    const source = findDirectoryEntry(snapshot, payload.relativePath);
    if (!source || source.revision !== payload.revision || source.ref.relativePath === entry.ref.relativePath) return;
    const mode = transferMode(event.ctrlKey);
    transfer.request(source, entry.ref, snapshot.root?.displayPath ?? snapshot.root?.displayName ?? entry.name, mode);
  }

  function activate() {
    store.select(entry);
    if (expandable) store.toggleDirectory(entry);
    else onOpen(entry.ref, 'pinned');
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
      draggable={transferable && !renaming}
      onDragStart={event => {
        if (!transferable) return;
        startWorkspaceDrag(entry);
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData(workspaceDragType, JSON.stringify(dragPayload(entry)));
        event.dataTransfer.setData('text/plain', entry.name);
      }}
      onDragEnd={endWorkspaceDrag}
      onDragOver={event => {
        if (!expandable) return;
        highlightDropTarget(event, entry.ref);
        event.preventDefault();
        event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
      }}
      onDragLeave={event => clearDropTarget(event.currentTarget)}
      onDrop={event => void transferTo(event)}
      data-drop-target={expandable ? true : undefined}
      onClick={activate}
      onDoubleClick={() => { if (!expandable && !['junction', 'symlink'].includes(entry.kind)) onOpen(entry.ref, 'pinned'); }}
      onKeyDown={navigate}
    >
      <span className={`tree-chevron ${expandable ? '' : 'tree-chevron-empty'}`} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="tree-icon"><EntryIcon entry={entry} /></span>
      <span className="tree-name">{entry.name}</span>
      {entry.isReadOnly && <span className="tree-badge">只读</span>}
      {(entry.kind === 'junction' || entry.kind === 'symlink') && <span className="tree-badge">链接</span>}
    </button>}
    {transfer.view}
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
    {creating && record.loaded && !record.loading && !record.error && <EntryInput
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
        if (result.value.kind === 'file') onOpen(result.value.ref, 'pinned');
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

export function Explorer({ currentReference, onOpen, onRenamed, onTrash, onReveal, onNewText, onChooseFile, onChooseFolder, onManageWorkspace, openEditors,
  mutationBlocked = false, store = workspace }: ExplorerProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [editing, setEditing] = useState<EditingEntry | null>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<ExplorerMenuTarget | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const transfer = useFileTransfer(store, onRenamed);
  const root = snapshot.root;
  const [menuRoot, setMenuRoot] = useState(root?.grant.grantId);
  if (menuRoot !== root?.grant.grantId) {
    setMenuRoot(root?.grant.grantId);
    setMenuTarget(null);
    setRootCollapsed(false);
  }
  const currentInRoot = snapshot.roots.some(item => currentReference?.grantId === item.grant.grantId);
  const createParent = creationParent(snapshot);
  const createRecord = createParent ? snapshot.records[createParent.relativePath] : null;
  const canCreate = Boolean(createParent && createRecord?.loaded
    && !createRecord.loading && !createRecord.error);
  const menuEntry = menuTarget?.path ? findDirectoryEntry(snapshot, menuTarget.path) : null;
  const menuParent = menuTarget && root ? creationParent({ ...snapshot, selectedPath: menuTarget.path }) : null;
  const menuParentEntry = menuParent?.relativePath ? findDirectoryEntry(snapshot, menuParent.relativePath) : null;
  const editReason = mutationBlocked || editing ? '请先结束当前操作。' : null;
  const createReason = editReason ?? (!menuParent ? '请先打开文件夹。'
    : menuParentEntry?.isReadOnly || (menuParentEntry && menuParentEntry.kind !== 'directory') ? '此目录不支持新建。' : null);
  const renameReason = editReason ?? (!menuEntry || ['junction', 'symlink'].includes(menuEntry.kind)
    ? '此项目不支持修改。' : null);

  useEffect(() => {
    if (currentReference && currentInRoot) void store.locate(currentReference).then(located => {
      if (located) setRootCollapsed(false);
    });
  }, [currentReference, currentInRoot, store]);

  useEffect(() => {
    if (!snapshot.selectedPath) return;
    const frame = requestAnimationFrame(() => {
      const tree = document.querySelector<HTMLElement>('[data-workspace-tree]');
      const row = [...(tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
        .find(candidate => candidate.dataset.treeKey === snapshot.selectedPath);
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot.selectedPath, root?.grant.grantId]);

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

  function beginCreate(mode: 'create-file' | 'create-directory', parent = createParent) {
    if (!parent || mutationBlocked || editing) return;
    if (parent.relativePath) {
      const entry = findDirectoryEntry(snapshot, parent.relativePath);
      if (entry?.kind === 'directory' && !snapshot.expanded[parent.relativePath]) {
        store.toggleDirectory(entry);
      }
    }
    if (snapshot.records[parent.relativePath]?.error) store.refresh(parent);
    setEditing({ mode, parent });
  }

  function showMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
    if (!(event.target instanceof Element) || event.target.closest('input, textarea, [role="menu"]')) return;
    const row = event.target.closest<HTMLElement>('[role="treeitem"]');
    // Keep native menus on controls such as filters and the inline name editor.
    if (!row && event.target.closest('button, label, summary, details') && !event.target.closest('.tree-root-label')) return;
    event.preventDefault(); event.stopPropagation();
    const path = row?.dataset.treeKey ?? null;
    const entry = path ? findDirectoryEntry(snapshot, path) : null;
    if (entry) store.select(entry);
    const origin = row ?? event.target.closest<HTMLElement>('.tree-root-label') ?? event.currentTarget;
    const bounds = origin.getBoundingClientRect();
    let x = bounds.left + 12;
    let y = bounds.top + Math.min(bounds.height, 28);
    if ('clientX' in event && (event.clientX !== 0 || event.clientY !== 0)) {
      x = event.clientX; y = event.clientY;
    }
    setMenuTarget({ path, grantId: root?.grant.grantId ?? null, origin,
      x, y });
  }

  async function transferToRoot(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    clearDropTarget(event.currentTarget);
    if (!root) return;
    const payload = parseDragPayload(event.dataTransfer.getData(workspaceDragType));
    if (!payload || payload.grantId !== root.grant.grantId) return;
    const source = findDirectoryEntry(snapshot, payload.relativePath);
    if (!source || source.revision !== payload.revision) return;
    const mode = transferMode(event.ctrlKey);
    transfer.request(source, root.grant, root.displayPath ?? root.displayName, mode);
  }

  return <section className="workspace-explorer" aria-label="文件树" tabIndex={-1} onContextMenu={showMenu} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { showMenu(event); return; }
    if (event.key !== 'Delete' || editing || mutationBlocked || !onTrash || !(event.target instanceof HTMLElement)) return;
    const key = event.target.closest<HTMLElement>('[role="treeitem"]')?.dataset.treeKey;
    const entry = key ? findDirectoryEntry(snapshot, key) : null;
    if (entry && !['junction', 'symlink'].includes(entry.kind)) { event.preventDefault(); onTrash(entry); }
  }}>
    <div className="explorer-heading explorer-titlebar">
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
        {root && <button type="button" className="icon-button compact" disabled={!!editing}
          onClick={() => store.refresh()} aria-label="刷新目录树" title="刷新">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
        </button>}
        {root && <button type="button" className="icon-button compact" aria-label="文件筛选" title="文件筛选" onClick={() => setFilterOpen(true)}
          data-active={snapshot.showHidden || snapshot.filters.include.length > 0 || snapshot.filters.exclude.length > 0 || !snapshot.filters.respectGitignore || snapshot.filters.followDirectoryLinks}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></svg>
        </button>}
        <button type="button" className="icon-button compact" aria-label="资源管理器更多操作" title="更多操作" aria-haspopup="menu" onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenuTarget({ path: null, grantId: root?.grant.grantId ?? null, origin: event.currentTarget, x: bounds.left, y: bounds.bottom });
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg></button>
      </div>
    </div>
    <div className="explorer-scroll">
    {openEditors}
    {!root && <div className="explorer-empty">
      <h3>尚未打开文件夹</h3>
    {onChooseFolder && <div className="explorer-open-actions">
      <button type="button" className="plain-button" disabled={mutationBlocked} onClick={onChooseFolder}>打开文件夹…</button>
    </div>}
    </div>}
    {root && <>
      {snapshot.roots.length > 1 && <label className="explorer-root-picker"><span className="visually-hidden">切换文件夹</span>
        <select aria-label="切换文件夹" value={root.grant.grantId} onChange={event => store.activateRoot(event.currentTarget.value)}>
          {snapshot.roots.map(item => <option key={item.grant.grantId} value={item.grant.grantId}>{item.displayName}</option>)}
        </select>
      </label>}
      <button type="button" className="tree-root-label" data-drop-target="true" aria-expanded={!rootCollapsed}
        onClick={() => setRootCollapsed(value => !value)}
        onDragOver={event => {
          highlightDropTarget(event, root.grant);
          event.preventDefault();
          event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
        }}
        onDragLeave={event => clearDropTarget(event.currentTarget)}
        onDrop={event => void transferToRoot(event)} title={root.displayPath ?? root.displayName}><span aria-hidden="true">{rootCollapsed ? '▸' : '▾'}</span><span className="tree-root-name">{root.displayName}</span></button>
      {snapshot.rootError ? <details className="explorer-problem">
        <summary>⚠ 文件夹暂不可用</summary><p>{snapshot.rootError}</p>
        <button type="button" className="plain-button" onClick={() => store.refresh()}>重新读取</button>
      </details> : null}
      <div className="tree" role="tree" aria-label={`${root.displayName} 文件树`} data-workspace-tree hidden={rootCollapsed}>
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
    </div>
    {root && filterOpen && <FilterRules key={root.grant.grantId} filters={snapshot.filters} onChange={filters => store.setFilters(filters)}
      showHidden={snapshot.showHidden} onShowHidden={value => store.setShowHidden(value)} onClose={() => {
        setFilterOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="文件筛选"]')?.focus());
      }} />}
    {transfer.view}
    {menuTarget && menuTarget.grantId === (root?.grant.grantId ?? null) && <ExplorerContextMenu
      target={menuTarget} onClose={() => setMenuTarget(null)} sections={[
        ...(menuEntry?.kind === 'file' ? [[
          { id: 'open', title: '打开文件', run: () => onOpen(menuEntry.ref, 'pinned') },
          ...(onReveal ? [{ id: 'reveal', title: '在文件资源管理器中显示',
            disabledReason: ['junction', 'symlink'].includes(menuEntry.kind) ? '链接项不支持在资源管理器中定位。' : null,
            run: () => onReveal(menuEntry) }] : []),
        ]]
          : menuEntry?.kind === 'directory' ? [[
            { id: 'expand', title: snapshot.expanded[menuEntry.ref.relativePath] ? '折叠文件夹' : '展开文件夹',
              run: () => store.toggleDirectory(menuEntry) },
            ...(onReveal ? [{ id: 'reveal', title: '在文件资源管理器中打开',
              disabledReason: ['junction', 'symlink'].includes(menuEntry.kind) ? '链接项不支持在资源管理器中定位。' : null,
              run: () => onReveal(menuEntry) }] : []),
          ]] : []),
        [
          ...(onManageWorkspace ? [{ id: 'manage-workspace', title: '工作区管理…', run: onManageWorkspace }] : []),
          { id: 'filter-files', title: '文件筛选…', disabledReason: !root ? '请先打开文件夹。' : null, run: () => setFilterOpen(true) },
          { id: 'locate-current', title: '定位当前文件', disabledReason: !currentInRoot ? '当前文件不属于工作区。' : null,
            run: () => { if (currentReference) void store.locate(currentReference); } },
          { id: 'create-file', title: '新建文件…', disabledReason: createReason, run: () => beginCreate('create-file', menuParent) },
          { id: 'create-directory', title: '新建文件夹…', disabledReason: createReason, run: () => beginCreate('create-directory', menuParent) },
          ...(onNewText ? [{ id: 'new-text', title: '新建未命名文本', disabledReason: editReason, run: onNewText }] : []),
        ],
        ...(menuEntry ? [[
          { id: 'rename', title: '重命名…', binding: 'F2', disabledReason: renameReason,
            run: () => beginEditing({ mode: 'rename', parent: menuEntry.ref, entry: menuEntry }) },
          ...(onTrash ? [{ id: 'trash', title: '移至回收站', binding: 'Delete', disabledReason: renameReason,
            run: () => onTrash(menuEntry) }] : []),
        ]] : []),
        [
          ...(onChooseFile ? [{ id: 'choose-file', title: '打开其他文件…', disabledReason: editReason, run: onChooseFile }] : []),
          ...(onChooseFolder && !menuEntry ? [{ id: 'choose-folder', title: '打开文件夹…', disabledReason: editReason, run: onChooseFolder }] : []),
          { id: 'refresh', title: '刷新目录', disabledReason: editReason ?? (!root ? '请先打开文件夹。' : null),
            run: () => store.refresh(menuParent) },
        ],
      ]} />}
  </section>;
}

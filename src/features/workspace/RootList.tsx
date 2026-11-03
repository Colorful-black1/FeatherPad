import { useSyncExternalStore, type DragEvent } from 'react';
import { workspace, type WorkspaceRoot } from './store';
import { findDirectoryEntry } from './file-actions';
import { parseDragPayload, transferConfirmation, transferMode, workspaceDragType } from './drag-drop';
import type { RenamedDocument } from '../../shared/contracts/files';

export function RootList({ busy, workspaceFile, onAdd, onRemove, onOpenFile, onSaveFile, onRenamed }: {
  busy: boolean; workspaceFile: string | null; onAdd: () => void;
  onRemove: (root: WorkspaceRoot) => void; onOpenFile: () => void; onSaveFile: () => void;
  onRenamed: (documents: readonly RenamedDocument[]) => void;
}) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  function move(index: number, delta: number) {
    const ids = snapshot.roots.map(root => root.grant.grantId);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    workspace.reorderRoots(ids);
  }
  async function transfer(root: WorkspaceRoot, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const payload = parseDragPayload(event.dataTransfer.getData(workspaceDragType));
    if (!payload) return;
    const source = findDirectoryEntry(snapshot, payload.relativePath);
    if (!source || source.ref.grantId !== payload.grantId || source.revision !== payload.revision) return;
    const mode = transferMode(event.ctrlKey);
    if (mode === 'move' && !window.confirm(transferConfirmation(source, root.displayName, mode))) return;
    const result = await workspace.transferEntry(source, root.grant, mode);
    if (!result.ok) window.alert(result.error.message);
    else onRenamed(result.value.renamedDocuments);
  }
  return <section className="workspace-roots" aria-label="工作区根">
    <div className="explorer-heading"><h2 className="sidebar-title">工作区根</h2>
      <div className="explorer-actions">
        <button className="plain-button" disabled={busy} onClick={onOpenFile}>打开工作区文件</button>
        <button className="plain-button" disabled={busy || snapshot.roots.length === 0} onClick={onSaveFile}>保存工作区文件</button>
        <button className="plain-button" disabled={busy || snapshot.roots.length >= 16} onClick={onAdd}>添加根…</button>
      </div></div>
    {workspaceFile && <small className="tree-state" title={workspaceFile}>工作区文件：{workspaceFile}</small>}
    <ul>{snapshot.roots.map((root, index) => <li key={root.grant.grantId}>
      <button className="plain-button root-name" aria-pressed={snapshot.root?.grant.grantId === root.grant.grantId}
        disabled={busy} title={root.displayPath ?? root.displayName} onClick={() => workspace.activateRoot(root.grant.grantId)}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move'; }}
        onDrop={event => void transfer(root, event)}>
        {root.displayName}<small>{root.displayPath ?? '选择后可浏览此根目录'}</small></button>
      <div className="root-actions">
        <button className="plain-button" aria-label={`上移根 ${root.displayName}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
        <button className="plain-button" aria-label={`下移根 ${root.displayName}`} disabled={busy || index === snapshot.roots.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button className="plain-button" aria-label={`移除根 ${root.displayName}`} disabled={busy} onClick={() => onRemove(root)}>移除</button>
      </div>
    </li>)}</ul>
    {snapshot.roots.length > 0 && <small>下方显示选中根的文件树。移除根会保留已打开文档。</small>}
  </section>;
}

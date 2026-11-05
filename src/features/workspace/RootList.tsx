import { useSyncExternalStore, type DragEvent } from 'react';
import { workspace, type WorkspaceRoot } from './store';
import { findDirectoryEntry } from './file-actions';
import { parseDragPayload, transferMode, workspaceDragType, highlightDropTarget, clearDropTarget } from './drag-drop';
import { useFileTransfer } from './use-file-transfer';
import type { RenamedDocument } from '../../shared/contracts/files';

export function RootList({ busy, workspaceFile, onAdd, onRemove, onOpenFile, onSaveFile, onRenamed }: {
  busy: boolean; workspaceFile: string | null; onAdd: () => void;
  onRemove: (root: WorkspaceRoot) => void; onOpenFile: () => void; onSaveFile: () => void;
  onRenamed: (documents: readonly RenamedDocument[]) => void;
}) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const fileTransfer = useFileTransfer(workspace, onRenamed);
  function move(index: number, delta: number) {
    const ids = snapshot.roots.map(root => root.grant.grantId);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    workspace.reorderRoots(ids);
  }
  async function transfer(root: WorkspaceRoot, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    clearDropTarget(event.currentTarget);
    const payload = parseDragPayload(event.dataTransfer.getData(workspaceDragType));
    if (!payload) return;
    const source = findDirectoryEntry(snapshot, payload.relativePath);
    if (!source || source.ref.grantId !== payload.grantId || source.revision !== payload.revision) return;
    const mode = transferMode(event.ctrlKey);
    fileTransfer.request(source, root.grant, root.displayPath ?? root.displayName, mode);
  }
  return <section className="workspace-roots" aria-label="工作区根">
    <div className="explorer-heading"><h2 className="sidebar-title">工作区根</h2>
      <div className="explorer-actions">
        <button className="plain-button" disabled={busy} onClick={onOpenFile}>打开工作区文件</button>
        <button className="plain-button" disabled={busy || snapshot.roots.length === 0} onClick={onSaveFile}>保存工作区文件</button>
        <button className="plain-button" disabled={busy || snapshot.roots.length >= 16} onClick={onAdd}>添加文件夹…</button>
      </div></div>
    {workspaceFile && <small className="tree-state" title={workspaceFile}>工作区文件：{workspaceFile}</small>}
    <ul>{snapshot.roots.map((root, index) => <li key={root.grant.grantId}>
      <button className="plain-button root-name" aria-pressed={snapshot.root?.grant.grantId === root.grant.grantId}
        disabled={busy} title={root.displayPath ?? root.displayName} onClick={() => workspace.activateRoot(root.grant.grantId)}
        onDragOver={event => { highlightDropTarget(event, root.grant); event.preventDefault(); event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move'; }}
        onDragLeave={event => clearDropTarget(event.currentTarget)}
        onDrop={event => void transfer(root, event)}>
        {root.displayName}<small>{root.displayPath ?? '选择后可浏览此根目录'}</small></button>
      <div className="root-actions">
        <button className="plain-button" aria-label={`上移根 ${root.displayName}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
        <button className="plain-button" aria-label={`下移根 ${root.displayName}`} disabled={busy || index === snapshot.roots.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button className="plain-button" aria-label={`移除根 ${root.displayName}`} disabled={busy} onClick={() => onRemove(root)}>移除</button>
      </div>
    </li>)}</ul>
    {snapshot.roots.length > 0 && <small>文件树显示当前选中的文件夹。移除文件夹会保留已打开文档。</small>}
    {fileTransfer.view}
  </section>;
}

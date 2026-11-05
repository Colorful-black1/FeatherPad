import { useEffect, useId, useRef, useState } from 'react';
import type { DirectoryEntry, FileRef, RenamedDocument, TransferMode } from '../../shared/contracts/files';
import type { WorkspaceStore } from './store';

interface PendingTransfer { source: DirectoryEntry; target: FileRef; targetName: string; mode: TransferMode }

export function useFileTransfer(store: WorkspaceStore, onRenamed: ((documents: readonly RenamedDocument[]) => void) | undefined) {
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const element = dialog.current;
    if (pending) { element?.showModal(); cancelButton.current?.focus(); }
    return () => element?.close();
  }, [pending]);

  function close() {
    setPending(null); setError(null);
    requestAnimationFrame(() => { if (origin.current?.isConnected) origin.current.focus(); });
  }
  async function perform(transfer: PendingTransfer) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const result = await store.transferEntry(transfer.source, transfer.target, transfer.mode);
      if (!result.ok) { if (mounted.current) setError(result.error.message); }
      else { onRenamed?.(result.value.renamedDocuments); if (mounted.current) close(); }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  function request(source: DirectoryEntry, target: FileRef, targetName: string, mode: TransferMode) {
    if (running.current || pending) return;
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const transfer = { source, target, targetName, mode };
    setError(null);
    if (mode === 'move') setPending(transfer);
    else void perform(transfer);
  }
  const view = <>
    {!pending && error && <p className="tree-state field-error" role="alert">{error}</p>}
    {pending && <dialog ref={dialog} className="file-operation-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <h2 id={titleId}>移动{pending.source.kind === 'directory' ? '文件夹' : '文件'}</h2>
      <dl><dt>来源</dt><dd>{pending.source.ref.relativePath}</dd>
        <dt>目标文件夹</dt><dd>{pending.targetName}{pending.target.relativePath ? ` / ${pending.target.relativePath}` : ''}</dd></dl>
      <p>移动后将更新已打开文档的路径；目标有同名项目时不会覆盖。</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <footer><button ref={cancelButton} type="button" className="plain-button" disabled={busy} onClick={close}>取消移动</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void perform(pending)}>{busy ? '正在移动…' : '确认移动'}</button></footer>
    </dialog>}
  </>;
  return { request, view };
}

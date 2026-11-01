import { useEffect, useRef, useState } from 'react';
import { files } from '../../bridge/files';
import type { DirectoryEntry, DocumentId, ResultEnvelope, SaveRequest, TrashEntryRequest, TrashEntryResult, TrashImpact } from '../../shared/contracts/files';
import type { WorkspaceStore } from './store';

interface TrashDialogProps {
  entry: DirectoryEntry;
  store: WorkspaceStore;
  documents: readonly { id: DocumentId; title: string; dirty: boolean }[];
  captureSnapshots: (ids: readonly DocumentId[]) => ResultEnvelope<SaveRequest[]>;
  saveDocuments: (ids: readonly DocumentId[]) => Promise<string | null>;
  onTrashed: (result: TrashEntryResult) => void;
  onClose: () => void;
}

export function TrashDialog({ entry, store, documents, captureSnapshots, saveDocuments, onTrashed, onClose }: TrashDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pending = useRef<TrashEntryRequest | null>(null);
  const [impact, setImpact] = useState<TrashImpact | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'trashing' | 'uncertain'>('loading');
  const [error, setError] = useState<string | null>(null);
  const busy = phase === 'loading' || phase === 'saving' || phase === 'trashing';
  const cannotCancel = phase === 'saving' || phase === 'trashing' || phase === 'uncertain';
  const dirty = impact?.affectedDocuments.filter(affected => documents.some(document => document.id === affected.documentId && document.dirty)) ?? [];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus();
    let active = true;
    void store.reloadEntry(entry.ref).then(async current => {
      if (!active) return;
      if (!current) { setError('项目已不在当前文件夹中，或目录读取失败。'); setPhase('ready'); return; }
      const result = await files.trashImpact({ ref: current.ref, expectedRevision: current.revision });
      if (!active) return;
      if (result.ok) setImpact(result.value);
      else setError(result.error.message);
      setPhase('ready');
    });
    return () => { active = false; element.close(); };
  }, [entry, store]);

  async function refreshImpact() {
    setPhase('loading');
    setError(null);
    const current = await store.reloadEntry(entry.ref);
    if (!current) {
      setImpact(null);
      setError('项目已不在当前文件夹中，或目录读取失败。请关闭后刷新目录。');
    } else {
      const result = await files.trashImpact({ ref: current.ref, expectedRevision: current.revision });
      if (result.ok) setImpact(result.value);
      else { setImpact(null); setError(result.error.message); }
    }
    setPhase('ready');
  }

  async function saveFirst() {
    if (!impact || phase !== 'ready') return;
    setPhase('saving');
    setError(null);
    const failure = await saveDocuments(impact.affectedDocuments.map(document => document.documentId));
    if (failure) { setError(failure); setPhase('ready'); return; }
    // Saving can replace the file identity and revision. Show a fresh confirmation before recycling.
    await refreshImpact();
  }

  async function submit() {
    if (phase !== 'ready' && phase !== 'uncertain') return;
    if (!pending.current) {
      if (!impact || error) return;
      const snapshots = captureSnapshots(impact.affectedDocuments.filter(document => document.canSnapshot).map(document => document.documentId));
      if (!snapshots.ok) { setError(snapshots.error.message); return; }
      pending.current = { ref: impact.ref, expectedRevision: impact.revision, expectedIdentity: impact.identity,
        requestId: crypto.randomUUID(), affectedDocumentIds: impact.affectedDocuments.map(document => document.documentId), snapshots: snapshots.value };
    }
    setPhase('trashing');
    setError(null);
    const result = await store.trashEntry(pending.current);
    if (result.ok) { pending.current = null; onTrashed(result.value); return; }
    setError(result.error.message);
    if (result.error.code === 'IPC_UNAVAILABLE') setPhase('uncertain');
    else { pending.current = null; setPhase('ready'); }
  }

  return <dialog ref={dialog} className="trash-dialog" aria-labelledby="trash-title" aria-describedby="trash-description"
    onCancel={event => { event.preventDefault(); if (!cannotCancel) onClose(); }}>
    <header><h2 id="trash-title">移至回收站</h2></header>
    <div className="trash-body" aria-busy={busy}>
      <p id="trash-description">将 1 个{entry.kind === 'directory' ? '文件夹及其中全部内容' : '文件'}移至系统回收站。</p>
      <p className="trash-path">{impact?.displayPath ?? entry.ref.relativePath}</p>
      {phase === 'loading' && <p aria-live="polite">正在核对项目和已打开文档…</p>}
      {impact && <>
        <p>影响 {impact.affectedDocuments.length} 个已打开文档，{dirty.length} 个有未保存修改。</p>
        {impact.affectedDocuments.length > 0 && <ul className="trash-documents">
          {impact.affectedDocuments.map(affected => <li key={affected.documentId}>
            <span>{affected.displayPath}</span>
            <strong>{documents.some(document => document.id === affected.documentId && document.dirty) ? '未保存修改' : affected.canSnapshot ? '已打开' : '只读预览'}</strong>
          </li>)}
        </ul>}
        <p className="trash-hint">已打开的完整缓冲会先保护为本地草稿；回收后仍保留当前内容，可另存为新文件。回收站不可用时停止操作。</p>
      </>}
      {phase === 'saving' && <p aria-live="polite">正在保存修改，尚未回收项目…</p>}
      {phase === 'trashing' && <p aria-live="polite">正在保护草稿并移至回收站…</p>}
      {error && <p className="trash-error" role="alert">{error}</p>}
      {phase === 'uncertain' && <p>上次操作的结果尚未确认。核对会复用原请求，不能取消已经发生的回收。</p>}
    </div>
    <footer>
      <button ref={cancel} className="plain-button" disabled={cannotCancel} onClick={onClose}>取消</button>
      {phase === 'ready' && error && <button className="plain-button" onClick={() => void refreshImpact()}>重新读取影响</button>}
      {dirty.length > 0 && <button className="plain-button" disabled={phase !== 'ready' || !!error}
        onClick={() => void saveFirst()}>保存修改并重新确认</button>}
      <button className="plain-button trash-primary" disabled={(phase !== 'ready' && phase !== 'uncertain') || (phase === 'ready' && (!impact || !!error))}
        onClick={() => void submit()}>{phase === 'uncertain' ? '核对上次结果' : dirty.length > 0 ? '保留草稿并移至回收站' : '移至回收站'}</button>
    </footer>
  </dialog>;
}

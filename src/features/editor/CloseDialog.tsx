import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';
import type { TabController } from './tabs';

export interface CloseTarget { id: DocumentId; version: number }
interface CloseDialogProps {
  target: CloseTarget;
  registry: DocumentRegistry;
  tabs: TabController;
  onClosed: () => void;
  onCancel: () => void;
}

export function CloseDialog({ target, registry, tabs, onClosed, onCancel }: CloseDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(target.version);
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const document = snapshot.documents.find(document => document.id === target.id);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);

  async function submit(choice: 'save' | 'discard') {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await tabs.close(target.id, version, choice);
      if (result.ok && result.value.closed) { onClosed(); return; }
      if (!result.ok) setError(result.error.code === 'CANCELLED' ? '保存已取消，文档尚未关闭。' : result.error.message);
      const latest = registry.getDocument(target.id);
      if (latest) setVersion(latest.summary.version);
    } finally {
      submitting.current = false;
      setBusy(false);
      cancel.current?.focus();
    }
  }

  return <dialog ref={dialog} className="trash-dialog close-dialog" aria-labelledby="close-document-title"
    aria-describedby="close-document-description" onCancel={event => { event.preventDefault(); if (!submitting.current) onCancel(); }}>
    <header><h2 id="close-document-title">关闭文档</h2></header>
    <div className="trash-body" aria-busy={busy}>
      <p id="close-document-description">是否保存对“{document?.title ?? '此文档'}”的修改？</p>
      {document?.displayPath && <p className="trash-path">{document.displayPath}</p>}
      <p className="trash-hint">放弃后将清理此版本的恢复副本。取消会保留当前内容。</p>
      {!busy && document && document.version !== version && <p className="notice">文档已有新修改，原确认已过期。下一次选择会先保留内容并要求重新确认。</p>}
      {busy && <p aria-live="polite">正在处理关闭，请等待结果…</p>}
      {error && <p className="trash-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button ref={cancel} type="button" className="plain-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="plain-button trash-primary" disabled={busy} onClick={() => void submit('discard')}>放弃修改并关闭</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void submit('save')}>保存并关闭</button>
    </footer>
  </dialog>;
}

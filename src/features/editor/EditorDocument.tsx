import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';
import { LargeFileView } from './LargeFileView';

export function EditorDocument({ registry, id, autoFocus }: { registry: DocumentRegistry; id: DocumentId; autoFocus: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const document = registry.getDocument(id);
  const readOnlyReason = document?.summary.readOnlyReason;
  const indentWidth = document?.summary.indentWidth;
  const languageId = document?.summary.languageId;
  const languageRevision = document?.summary.languageRevision;
  const bracketMatching = document?.summary.bracketMatching;
  const closeBrackets = document?.summary.closeBrackets;
  const closing = document?.summary.closing;
  const hotExitFrozen = document?.summary.hotExitFrozen;
  useEffect(() => {
    const record = registry.getDocument(id);
    if (!parent.current || !record) return;
    const view = new EditorView({
      parent: parent.current,
      state: record.state,
      dispatchTransactions(transactions, editor) {
        const result = registry.commit(id, transactions);
        if (result.ok) editor.update(transactions);
        else {
          setError(result.error.message);
          const latest = registry.getDocument(id);
          if (latest) editor.setState(latest.state);
        }
      },
    });
    const detachView = registry.attachView(id, view);
    const onScroll = () => registry.setScroll(id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    if (autoFocus) view.focus();
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      registry.setScroll(id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      detachView();
      view.destroy();
    };
  }, [id, registry, autoFocus, readOnlyReason, indentWidth, languageId, languageRevision,
    bracketMatching, closeBrackets, closing, hotExitFrozen]);
  if (!document) return null;
  return <section className="document-view" role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
    <header className="document-heading"><span>{document.summary.displayPath ?? document.summary.title}</span><span>{document.source?.mode === 'large-readonly' ? '只读分块' : document.source?.mode === 'head-preview' ? '限量预览' : document.summary.readOnlyReason ? '只读' : document.source?.mode === 'degraded' ? '纯文本 · 降级' : '文本'}</span></header>
    {document.summary.missing && <p className="notice" role="note">原文件当前不可用，当前内容仍保留。
      {document.fragment ? '预览不能继续分页或保存，请从系统回收站恢复原文件。'
        : document.summary.recoveryProtected ? '草稿已获得落盘保护。请另存为保留文件。' : '最近修改仍在内存中，请另存为保留。'}</p>}
    {document.summary.recoveryError && <p className="notice" role="alert">自动恢复保护失败：{document.summary.recoveryError}
      当前正文仍在内存中；请另存为保留文件。</p>}
    {document.summary.recovered && <p className="notice" role="note">
      {document.source ? '已恢复未保存内容，请核对后保存。'
        : '已从本地恢复记录打开未保存副本，保存时将要求另存为新文件。'}
      {!document.summary.recoveryProtected && '当前副本尚未确认新的恢复快照，原恢复记录仍保留。'}
    </p>}
    {document.summary.readOnlyReason && <p className="notice">{document.summary.readOnlyReason}</p>}
    {document.source?.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    {error && <p className="notice" role="alert">{error}</p>}
    {document.fragment ? <LargeFileView document={document} /> : <div className="codemirror-host" ref={parent} />}
  </section>;
}

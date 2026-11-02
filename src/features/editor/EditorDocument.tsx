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
    view.scrollDOM.scrollTop = record.scroll.top;
    view.scrollDOM.scrollLeft = record.scroll.left;
    if (autoFocus) view.focus();
    return () => {
      registry.setScroll(id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      detachView();
      view.destroy();
    };
  }, [id, registry, autoFocus, readOnlyReason, indentWidth, languageId, languageRevision, bracketMatching, closeBrackets, closing]);
  if (!document) return null;
  return <section className="document-view" role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
    <header className="document-heading"><span>{document.summary.displayPath ?? document.summary.title}</span><span>{document.source?.mode === 'large-readonly' ? '只读分块' : document.source?.mode === 'head-preview' ? '限量预览' : document.summary.readOnlyReason ? '只读' : document.source?.mode === 'degraded' ? '纯文本 · 降级' : '文本'}</span></header>
    {document.summary.missing && <p className="notice" role="note">文件已移至回收站，当前内容仍保留。
      {document.fragment ? '预览不能继续分页或保存，请从系统回收站恢复原文件。'
        : document.summary.recoveryProtected ? '草稿已获得落盘保护。请另存为保留文件。' : '最近修改仍在内存中，请另存为保留。'}</p>}
    {document.summary.readOnlyReason && <p className="notice">{document.summary.readOnlyReason}</p>}
    {document.source?.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    {error && <p className="notice" role="alert">{error}</p>}
    {document.fragment ? <LargeFileView document={document} /> : <div className="codemirror-host" ref={parent} />}
  </section>;
}

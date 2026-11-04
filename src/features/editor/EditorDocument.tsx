import { useLayoutEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';
import { LargeFileView } from './LargeFileView';

export function EditorDocument({ registry, id, autoFocus, group }: {
  registry: DocumentRegistry; id: DocumentId; autoFocus: boolean; group: 'primary' | 'secondary';
}) {
  const parent = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
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
  useLayoutEffect(() => {
    const record = registry.getDocument(id);
    if (!parent.current || !record) return;
    if (performance.getEntriesByName('featherpad:editor-mount-start').length === 0) {
      performance.mark('featherpad:editor-mount-start');
    }
    const view = new EditorView({
      parent: parent.current,
      state: record.state,
      dispatchTransactions(transactions, editor) {
        const result = registry.commit(id, transactions, editor);
        if (result.ok) editor.update(transactions);
        else {
          setError(result.error.message);
          const latest = registry.getDocument(id);
          if (latest) editor.setState(latest.state);
        }
      },
    });
    const detachView = registry.attachView(id, view);
    // A delayed viewer can replace the fallback editor within the default
    // history grouping window. Preserve edits from both views but keep that
    // replacement as a hard undo boundary so the first undo cannot remove text
    // typed before the viewer loaded.
    view.dispatch({ annotations: isolateHistory.of('full') });
    if (performance.getEntriesByName('featherpad:editor-mount-complete').length === 0) {
      performance.mark('featherpad:editor-mount-complete');
    }
    const onScroll = () => registry.setScroll(id, view, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    if (restoreFocus.current) view.focus();
    let readyFrame = 0;
    if (!readOnlyReason && performance.getEntriesByName('featherpad:editor-interactive').length === 0) {
      readyFrame = requestAnimationFrame(() => {
        readyFrame = requestAnimationFrame(() => {
          if (view.contentDOM.isConnected && view.hasFocus) performance.mark('featherpad:editor-interactive');
        });
      });
    }
    return () => {
      restoreFocus.current = view.hasFocus;
      cancelAnimationFrame(readyFrame);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      registry.setScroll(id, view, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      detachView();
      view.destroy();
    };
  }, [id, registry, readOnlyReason, indentWidth, languageId, languageRevision,
    bracketMatching, closeBrackets, closing, hotExitFrozen]);
  // A focus request must not destroy and recreate the editor. Reconfiguration
  // restores focus only if this view owned it, leaving forms and dialogs alone.
  useLayoutEffect(() => { if (autoFocus) registry.focus(id); }, [autoFocus, id, registry]);
  if (!document) return null;
  const textPreview = document.source?.mode === 'text-preview' && document.fragment?.kind === 'head'
    ? document.fragment : null;
  return <section className="document-view" role="tabpanel" id={`panel-${group}-${id}`}
    data-editor-group={group} aria-label={`${group === 'primary' ? '主编辑组' : '第二编辑组'}：${document.summary.title}`}
    tabIndex={-1}>
    <header className="document-heading"><span>{document.summary.displayPath ?? document.summary.title}</span><span>{document.source?.mode === 'text-preview' ? '只读试开' : document.source?.mode === 'large-readonly' ? '只读分块' : document.source?.mode === 'head-preview' ? '限量预览' : document.summary.readOnlyReason ? '只读' : document.source?.mode === 'degraded' ? '纯文本 · 降级' : '文本'}</span></header>
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
    {textPreview && <p className="notice">已试读 {textPreview.previewBytes.toLocaleString('zh-CN')} / {textPreview.totalBytes.toLocaleString('zh-CN')} 字节
      {textPreview.truncated ? '，内容已截断。' : '，已完整显示文件的只读文本解释。'}</p>}
    {document.source?.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    {error && <p className="notice" role="alert">{error}</p>}
    {document.fragment && document.source?.mode !== 'text-preview'
      ? <LargeFileView document={document} /> : <div className="codemirror-host" ref={parent} />}
  </section>;
}

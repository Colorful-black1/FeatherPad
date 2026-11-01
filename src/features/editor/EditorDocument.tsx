import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';

export function EditorDocument({ registry, id, autoFocus }: { registry: DocumentRegistry; id: DocumentId; autoFocus: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const document = registry.getDocument(id);
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
    view.scrollDOM.scrollTop = record.scroll.top;
    view.scrollDOM.scrollLeft = record.scroll.left;
    if (autoFocus) view.focus();
    return () => {
      registry.setScroll(id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      view.destroy();
    };
  }, [id, registry, autoFocus]);
  if (!document) return null;
  return <section className="document-view" role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
    <header className="document-heading"><span>{document.summary.displayPath ?? document.summary.title}</span><span>{document.summary.readOnlyReason ? '只读' : '文本'}</span></header>
    {document.summary.readOnlyReason && <p className="notice">{document.summary.readOnlyReason}</p>}
    {document.source?.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    {error && <p className="notice" role="alert">{error}</p>}
    <div className="codemirror-host" ref={parent} />
  </section>;
}

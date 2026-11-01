import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import type { OpenDocument } from '../../shared/contracts/files';

export function ReadOnlyDocument({ document }: { document: OpenDocument }) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!parent.current) return;
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: document.content.text,
        extensions: [
          lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '文档内容（只读）', 'aria-readonly': 'true', tabindex: '0' }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--bg-editor)', color: 'var(--text-primary)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--editor-size)', overflow: 'auto' },
            '.cm-gutters': { backgroundColor: 'var(--bg-editor)', color: 'var(--text-muted)', borderRight: 'none' },
            '.cm-content': { padding: '16px 0', lineHeight: '1.85' },
            '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [document]);
  return <section className="document-view" aria-label={document.metadata.displayPath}>
    <header className="document-heading"><span>{document.metadata.displayPath}</span><span>只读</span></header>
    {document.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    <div className="codemirror-host" ref={parent} />
  </section>;
}

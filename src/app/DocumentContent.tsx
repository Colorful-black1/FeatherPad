import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { EditorDocument } from '../features/editor/EditorDocument';
import type { MarkdownViewProps } from '../features/markdown/MarkdownView';

type ContentKind = 'markdown' | 'html' | 'image';
const loaders: Record<ContentKind, () => Promise<ComponentType<MarkdownViewProps>>> = {
  markdown: () => import('../features/markdown/MarkdownView').then(module => module.MarkdownView),
  html: () => import('../features/editor/HtmlPreview').then(module => module.HtmlPreview),
  image: () => import('../features/editor/ImageView').then(module => module.ImageView),
};

// Composition owns the optional viewers; the generic editor stays independent.
export function DocumentContent(props: MarkdownViewProps) {
  const record = props.registry.getDocument(props.id);
  const kind = record?.fragment?.kind === 'image' ? 'image'
    : !record?.fragment && record?.summary.languageId === 'markdown' ? 'markdown'
      : !record?.fragment && record?.summary.languageId === 'html' ? 'html' : null;
  return kind ? <OptionalContent key={kind} kind={kind} {...props} /> : <EditorDocument {...props} />;
}

function OptionalContent({ kind, ...props }: MarkdownViewProps & { kind: ContentKind }) {
  const [loaded, setLoaded] = useState<{ kind: ContentKind; View: ComponentType<MarkdownViewProps>; restoreFocus: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null), composing = useRef(false);
  const pendingMount = useRef<(() => void) | null>(null), compositionFrame = useRef(0);
  useLayoutEffect(() => {
    if (loaded?.restoreFocus && document.activeElement === document.body && !document.querySelector('dialog[open]')) {
      root.current?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]')?.focus();
    }
  }, [loaded]);
  useEffect(() => {
    let disposed = false;
    void loaders[kind]().then(View => {
      const mount = () => {
        if (disposed) return;
        if (composing.current) { pendingMount.current = mount; return; }
        pendingMount.current = null;
        const focused = document.activeElement;
        setLoaded({ kind, View, restoreFocus: !!focused && !!root.current?.contains(focused) && focused.matches('.cm-content') });
      };
      mount();
    },
      () => { if (!disposed) setFailed(true); });
    return () => { disposed = true; pendingMount.current = null; cancelAnimationFrame(compositionFrame.current); };
  }, [kind, attempt]);
  return <div className="markdown-view" ref={root}
    onCompositionStartCapture={() => { cancelAnimationFrame(compositionFrame.current); composing.current = true; }}
    onCompositionEndCapture={() => {
      cancelAnimationFrame(compositionFrame.current);
      compositionFrame.current = requestAnimationFrame(() => {
        compositionFrame.current = requestAnimationFrame(() => { composing.current = false; pendingMount.current?.(); });
      });
    }}>
    {loaded?.kind === kind ? <loaded.View {...props} /> : <><p className="notice" role={failed ? 'alert' : 'status'}>
      {failed ? '视图加载失败。' : '正在加载视图…'}
      {failed && <button type="button" className="plain-button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试</button>}
    </p>
    {kind === 'image' ? <p className="notice">图片保持只读。</p> : <EditorDocument {...props} />}</>}
  </div>;
}

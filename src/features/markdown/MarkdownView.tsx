import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { EditorDocument } from '../editor/EditorDocument';
import { markdownFrame } from './frame';
import { useMarkdownRender } from './use-markdown-render';

interface DocumentContentProps {
  registry: DocumentRegistry; id: DocumentId; autoFocus: boolean;
  group: 'primary' | 'secondary'; dark: boolean;
}
type MarkdownMode = 'source' | 'read' | 'split';

// App composition owns this adapter. The generic editor has no dependency on
// Markdown; both groups continue sharing the same registry and undo history.
export function DocumentContent(props: DocumentContentProps) {
  const record = props.registry.getDocument(props.id);
  return record?.summary.languageId === 'markdown' && !record.fragment
    ? <MarkdownView {...props} /> : <EditorDocument {...props} />;
}

function MarkdownView({ registry, id, autoFocus, group, dark }: DocumentContentProps) {
  const root = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<MarkdownMode>('source');
  const [ratio, setRatio] = useState(50);
  const [compact, setCompact] = useState(false);
  const record = registry.getDocument(id)!;
  const version = record.summary.version;
  const effectiveMode = mode === 'split' && compact ? 'read' : mode;
  const render = useMarkdownRender(registry, id, version, effectiveMode !== 'source');
  const frame = useMemo(() => render.state?.reply ? markdownFrame(render.state.reply.html, dark) : '',
    [render.state, dark]);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(entries => setCompact((entries[0]?.contentRect.width ?? 0) < 650));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  function changeMode(next: MarkdownMode) {
    setMode(next);
    if (next !== 'read') requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('.cm-content')?.focus();
    });
  }

  return <div className="markdown-view" ref={root} data-markdown-mode={effectiveMode}>
    <header className="markdown-toolbar">
      <div role="group" aria-label={`${group === 'primary' ? '主编辑组' : '第二编辑组'} Markdown视图`}>
        {(['source', 'read', 'split'] as const).map((value, index) => <button type="button" key={value}
          className="plain-button" aria-pressed={mode === value} onClick={() => changeMode(value)}>
          {['源码', '阅读', '分屏'][index]}</button>)}
      </div>
      <span>{effectiveMode === 'source' ? 'Markdown · 同一正文缓冲' : `阅读快照 · v${version}`}</span>
    </header>
    {mode === 'split' && compact && <p className="notice" role="note">空间不足，分屏暂以阅读显示；可切换源码或扩大编辑区域。</p>}
    <div className={`markdown-panes markdown-${effectiveMode}`} style={{ '--markdown-ratio': `${ratio}%` } as CSSProperties}>
      <div className="markdown-source" hidden={effectiveMode === 'read'}>
        <EditorDocument registry={registry} id={id} group={group} autoFocus={autoFocus} />
      </div>
      {effectiveMode === 'split' && <div className="markdown-divider" role="separator" tabIndex={0}
        aria-label="源码与阅读分隔" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={ratio}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setRatio(value => event.key === 'Home' ? 25 : event.key === 'End' ? 75
            : Math.max(25, Math.min(75, value + (event.key === 'ArrowLeft' ? -1 : 1))));
        }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
          setRatio(Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100)));
        }} />}
      {effectiveMode !== 'source' && <section className="markdown-reading" aria-label="Markdown阅读预览"
        aria-busy={!render.state || render.state.status === 'loading'}>
        {!render.state || render.state.status === 'loading'
          ? <div className="markdown-render-status"><p role="status">正在生成阅读快照…</p>
            <button type="button" className="plain-button" onClick={render.cancel}>取消渲染</button></div>
          : render.state.status === 'ready'
            ? <><iframe title={`${record.summary.title} Markdown阅读 · ${group}`} sandbox="" srcDoc={frame} />
              {Boolean(render.state.reply?.blockedResources) && <p className="notice" role="note">
                {render.state.reply?.blockedResources}张图片未加载；预览不会自动访问网络或本地路径。</p>}</>
            : <div className="markdown-render-status"><p role={render.state.status === 'error' ? 'alert' : 'status'}>{render.state.message}</p>
              <button type="button" className="plain-button" onClick={render.retry}>生成一次预览</button></div>}
      </section>}
    </div>
  </div>;
}

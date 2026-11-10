import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { EditorDocument } from '../editor/EditorDocument';
import { markdownBody, markdownFrameShell } from './frame';
import { useMarkdownRender } from './use-markdown-render';
import { toggleMarkdownTask } from './task-mapping';
import { redo, undo } from '@codemirror/commands';
import { files } from '../../bridge/files';
import { useMarkdownResources } from './use-markdown-resources';
import { ResourcePanel } from './ResourcePanel';
import { usePreviewLinks } from './use-preview-links';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import { prepareRawHtml } from './raw-html';
import { Outline } from './Outline';
import { useMarkdownScroll } from './scroll-sync';
import { ExportDialog } from './ExportDialog';
import { loadMarkdownMode, saveMarkdownMode, type MarkdownMode } from '../../shared/ui/view-preferences';

export interface MarkdownViewProps {
  registry: DocumentRegistry; id: DocumentId; autoFocus: boolean;
  group: 'primary' | 'secondary'; dark: boolean;
  allowHtml: boolean;
  onActivate?: () => void;
  onOpenFile?: (reference: FileRef) => void;
}
export function MarkdownView({ registry, id, autoFocus, group, dark, allowHtml, onActivate, onOpenFile }: MarkdownViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [modePreference] = useState(loadMarkdownMode);
  const [mode, setMode] = useState<MarkdownMode>(modePreference.value);
  const [ratio, setRatio] = useState(50);
  const [compact, setCompact] = useState(false);
  const [notice, setNotice] = useState<string | null>(modePreference.warning);
  const [directory, setDirectory] = useState<FileRef | null>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const restorePreviewFocus = useRef(false);
  const record = registry.getDocument(id)!;
  const version = record.summary.version;
  const channel = useMemo(() => `${crypto.randomUUID().replaceAll('-', '')}${id.length.toString(36)}`, [id]);
  const effectiveMode = mode === 'split' && compact ? 'read' : mode;
  const render = useMarkdownRender(registry, id, version, effectiveMode !== 'source', allowHtml);
  const rawReply = effectiveMode === 'source' ? undefined : render.state?.reply;
  const reply = useMemo(() => rawReply ? prepareRawHtml(rawReply) : undefined, [rawReply]);
  const displayedReply = reply;
  const resources = useMarkdownResources(registry, id, displayedReply, directory);
  const links = usePreviewLinks({ registry, id, directory, reply: displayedReply,
    frame: previewFrame, channel, onNotice: setNotice, onOpenFile });
  const openPreviewLink = links.openIndex;
  const scroll = useMarkdownScroll({ registry, id, root, frame: previewFrame, reply: displayedReply, channel,
    enabled: syncScroll, split: effectiveMode === 'split', previewAction: restorePreviewFocus });
  const previewScroll = scroll.previewScroll;
  const syncFromSource = scroll.syncFromSource;
  const readOnly = !!record.summary.readOnlyReason || record.summary.closing || record.summary.hotExitFrozen;
  const frameKey = `${channel}:${dark}:${readOnly}`;
  const frameShell = useMemo(() => markdownFrameShell(dark, channel, readOnly),
    [dark, channel, readOnly]);
  const frameBody = useMemo(() => displayedReply
    ? markdownBody(displayedReply.html, resources.images, displayedReply.images) : '',
  [displayedReply, resources.images]);
  useEffect(() => {
    if (loadedFrame !== frameKey || !frameBody) return;
    previewFrame.current?.contentWindow?.postMessage({ channel, kind: 'render', html: frameBody }, '*');
    // The preview no longer reports its transient post-render position, so
    // split view pushes the current source block after each snapshot update.
    syncFromSource();
  }, [channel, frameBody, frameKey, loadedFrame, syncFromSource]);
  useEffect(() => {
    if (!displayedReply) return;
    const receive = (event: MessageEvent<unknown>) => {
      if (!previewFrame.current || event.source !== previewFrame.current.contentWindow || event.origin !== 'null'
        || !event.data || typeof event.data !== 'object' || Reflect.get(event.data, 'channel') !== channel
        || document.querySelector('dialog[open]')) return;
      const index: unknown = Reflect.get(event.data, 'index');
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return;
      const kind: unknown = Reflect.get(event.data, 'kind');
      if (registry.getDocument(id)?.summary.version !== displayedReply.bufferVersion && kind !== 'history') return;
      if (kind === 'task' && !readOnly) {
        const task = displayedReply.tasks[index];
        if (!task) return;
        onActivate?.();
        restorePreviewFocus.current = true;
        const result = toggleMarkdownTask(registry, id, displayedReply.bufferVersion, task);
        if (!result.ok) setNotice(result.error.message);
      } else if (kind === 'copy') {
        const block = displayedReply.codeBlocks[index];
        if (!block) return;
        onActivate?.();
        void navigator.clipboard.writeText(block.text).then(() => {
          setNotice('代码已复制。');
          previewFrame.current?.contentWindow?.postMessage({ channel, kind: 'copied', index }, '*');
        }, () => {
          setNotice('无法写入剪贴板，请在源码中复制。');
          previewFrame.current?.contentWindow?.postMessage({ channel, kind: 'copyFailed', index }, '*');
        });
      } else if (kind === 'history' && !readOnly && index <= 1) {
        onActivate?.();
        restorePreviewFocus.current = true;
        registry.runEditorCommand(id, index === 0 ? undo : redo);
      } else if (kind === 'link') {
        onActivate?.();
        openPreviewLink(index);
      } else if (kind === 'scroll') {
        previewScroll(index);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [displayedReply, channel, id, registry, readOnly, onActivate, openPreviewLink, previewScroll]);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(entries => setCompact((entries[0]?.contentRect.width ?? 0) < 650));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  function changeMode(next: MarkdownMode) {
    setMode(next);
    const warning = saveMarkdownMode(next);
    setNotice(warning);
    if (next !== 'read') requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('.cm-content')?.focus();
    });
  }
  function chooseDirectory() {
    void files.chooseFolder().then(result => {
      if (!result.ok) setNotice(result.error.message);
      else if (result.value.grant) setDirectory(result.value.grant);
    });
  }

  return <div className="markdown-view" ref={root} data-markdown-mode={effectiveMode}>
    <header className="markdown-toolbar">
      <div role="group" aria-label={`${group === 'primary' ? '主编辑组' : '第二编辑组'} Markdown视图`}>
        {(['source', 'read', 'split'] as const).map((value, index) => <button type="button" key={value}
          className="plain-button" aria-pressed={mode === value} onClick={() => changeMode(value)}>
          {['源码', '阅读', '分屏'][index]}</button>)}
      </div>
      <span aria-hidden="true" className="toolbar-spacer" />
      {effectiveMode === 'split' && <label className="toolbar-check"><input type="checkbox" aria-label="Markdown同步滚动"
        checked={syncScroll} disabled={Boolean(reply?.mappingWarning)} onChange={event => setSyncScroll(event.currentTarget.checked)} />同步滚动</label>}
      <button type="button" className="plain-button" disabled={record.summary.closing || record.summary.hotExitFrozen}
        onClick={() => setExportOpen(true)}>导出…</button>
    </header>
    {notice && <p className="notice" role="status">{notice}</p>}
    {exportOpen && <ExportDialog registry={registry} id={id} directory={directory} allowHtml={allowHtml}
      onClose={() => setExportOpen(false)} onSaved={setNotice} />}
    {reply?.htmlWarning && <p className="notice" role="alert">{reply.htmlWarning}</p>}
    {reply?.mappingWarning && <p className="notice" role="status">{reply.mappingWarning}</p>}
    {links.pending && <ExternalLinkDialog url={links.pending.url} busy={links.busy}
      onCancel={links.close} onConfirm={() => void links.confirm()} />}
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
        {displayedReply && <Outline headings={displayedReply.headings} onGo={scroll.go} />}
        <iframe key={`preview-${channel}`} ref={previewFrame} title={`${record.summary.title} Markdown阅读 · ${group}`} sandbox="allow-scripts" srcDoc={frameShell}
          onLoad={() => {
            setLoadedFrame(frameKey);
            previewFrame.current?.contentWindow?.postMessage({ channel, kind: 'render', html: frameBody }, '*');
            scroll.frameReady();
            if (!restorePreviewFocus.current) return;
            restorePreviewFocus.current = false;
            previewFrame.current?.focus();
            previewFrame.current?.contentWindow?.focus();
          }} />
        {!frameBody && (render.state && !['loading', 'ready'].includes(render.state.status)
          ? <div className="markdown-render-status"><p role={render.state.status === 'error' ? 'alert' : 'status'}>{render.state.message}</p>
            <button type="button" className="plain-button" onClick={render.retry}>生成一次预览</button></div>
          : <div className="markdown-render-status"><p role="status">正在生成阅读快照…</p>
            <button type="button" className="plain-button" onClick={render.cancel}>取消渲染</button></div>)}
        {frameBody && (!render.state || render.state.status === 'loading') && <div className="markdown-render-status">
          <p role="status">正在更新阅读快照…</p>
          <button type="button" className="plain-button" onClick={render.cancel}>取消渲染</button>
        </div>}
        {frameBody && render.state && render.state.status !== 'loading' && render.state.status !== 'ready' && <div className="markdown-render-status">
          <p role={render.state.status === 'error' ? 'alert' : 'status'}>{render.state.message}</p>
          <button type="button" className="plain-button" onClick={render.retry}>生成一次预览</button>
        </div>}
        {displayedReply && <ResourcePanel busy={resources.busy} failures={resources.failures}
          labels={displayedReply.images} onChooseDirectory={chooseDirectory} onOpenUrl={links.openUrl} />}
      </section>}
    </div>
  </div>;
}

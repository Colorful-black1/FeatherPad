import { useEffect, useMemo, useRef, useState } from 'react';
import { files } from '../../bridge/files';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import { prepareStaticHtml, staticHtmlFrame, type StaticHtml } from '../../shared/preview/static-html';
import { resolvePreviewImages, type PreviewResourceResult } from '../../shared/preview/resources';
import type { DocumentRegistry } from './documents';
import { EditorDocument } from './EditorDocument';

interface PreviewState { key: string; status: 'loading' | 'paused' | 'ready' | 'error'; message?: string; snapshot?: StaticHtml; resources?: PreviewResourceResult }
export function HtmlPreview(props: { registry: DocumentRegistry; id: DocumentId; group: 'primary' | 'secondary'; autoFocus: boolean; dark: boolean }) {
  const { registry, id, dark } = props;
  const [mode, setMode] = useState<'source' | 'preview'>('source');
  const [directory, setDirectory] = useState<FileRef | null>(null);
  const [manualVersion, setManualVersion] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const record = registry.getDocument(id)!;
  const version = record.summary.version, sourcePath = record.source?.metadata.displayPath ?? null;
  const key = JSON.stringify([id, version, sourcePath, directory]);
  const current = state?.key === key ? state : null;
  useEffect(() => {
    if (mode !== 'preview') return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && registry.getDocument(id)?.summary.version === version
      && (registry.getDocument(id)?.source?.metadata.displayPath ?? null) === sourcePath;
    cancel.current = () => controller.abort();
    const timer = setTimeout(() => {
      void (async () => {
        const document = registry.getDocument(id); if (!document || !current()) return;
        if (document.fragment || document.state.doc.length >= 20 * 1024 * 1024) throw new Error('限量或20MiB以上内容不能生成完整HTML预览。');
        const source = document.state.doc.toString();
        if (new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024 && manualVersion !== version) {
          setState({ key, status: 'paused', message: 'HTML超过2MiB，已暂停自动预览；可按需生成一次。' }); return;
        }
        setState({ key, status: 'loading' });
        const started = performance.now();
        const snapshot = prepareStaticHtml(source);
        if (performance.now() - started > 2000) throw new Error('HTML清洗超过2秒预算，已停止；源码保留。');
        controller.signal.throwIfAborted();
        const resources = await resolvePreviewImages(snapshot.images, { documentId: document.source ? id : null, directory }, controller.signal);
        if (current()) setState({ key, status: 'ready', snapshot, resources });
      })().catch((error: unknown) => {
        if (current()) setState({ key, status: 'error', message: error instanceof Error ? error.message : 'HTML静态预览失败，源码保留。' });
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); cancel.current = null; };
  }, [registry, id, mode, key, version, sourcePath, directory, manualVersion, attempt]);
  const frame = useMemo(() => current?.status === 'ready' && current.snapshot && current.resources
    ? staticHtmlFrame(current.snapshot, current.resources.images, dark) : '', [current, dark]);
  function retry() { setManualVersion(version); setAttempt(value => value + 1); }
  function stop() { cancel.current?.(); setState({ key, status: 'paused', message: '已取消HTML预览，源码保留。' }); }
  async function chooseDirectory() {
    const result = await files.chooseFolder();
    if (result.ok && result.value.grant) setDirectory(result.value.grant);
    else if (!result.ok) setMessage(result.error.message);
  }
  return <div className="html-view">
    <div className="markdown-toolbar" role="group" aria-label="HTML视图">
      <button type="button" className="plain-button" aria-pressed={mode === 'source'} onClick={() => {
        setMode('source'); cancel.current?.(); requestAnimationFrame(() => registry.focus(id));
      }}>源码</button>
      <button type="button" className="plain-button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>静态预览</button>
      <span aria-hidden="true" className="toolbar-spacer" />
    </div>
    {message && <p className="notice" role="alert">{message}</p>}
    <div hidden={mode !== 'source'} className="html-source"><EditorDocument {...props} /></div>
    {mode === 'preview' && <section className="html-reading" aria-label="HTML静态预览" aria-busy={!current || current.status === 'loading'}>
      {!current || current.status === 'loading' ? <div className="markdown-render-status"><p role="status">正在生成安全静态快照…</p><button type="button" className="plain-button" onClick={stop}>取消预览</button></div>
        : current.status !== 'ready' ? <div className="markdown-render-status"><p role={current.status === 'error' ? 'alert' : 'status'}>{current.message}</p><button type="button" className="plain-button" onClick={retry}>生成一次静态预览</button></div>
          : <iframe title={`${record.summary.title} HTML静态预览 · ${props.group}`} sandbox="" srcDoc={frame} />}
      {current?.resources && <details className="markdown-resource-details"><summary>图片资源 · {current.resources.images.size}已加载 / {current.resources.failures.length}未加载</summary>
        {current.resources.failures.length > 0 && <ul>{current.resources.failures.slice(0, 100).map(failure => <li key={failure.index}>{current.snapshot?.images[failure.index]?.alt || `图片${failure.index + 1}`}：{failure.reason}</li>)}</ul>}
        {current.resources.failures.length > 100 && <p>仅显示前100项。</p>}
        <button type="button" className="plain-button" onClick={() => void chooseDirectory()}>授权或选择HTML资源目录…</button>
      </details>}
    </section>}
  </div>;
}

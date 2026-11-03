import { useEffect, useRef, useState } from 'react';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { previewBridge, type PdfOptions } from '../../bridge/preview';
import { prepareHtmlExport, renderExport, type HtmlExport } from './export-html';
import { MAX_RENDER_BYTES } from './parser';

export function ExportDialog({ registry, id, directory, allowHtml, onClose, onSaved }: {
  registry: DocumentRegistry; id: DocumentId; directory: FileRef | null; allowHtml: boolean;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const [snapshot] = useState(() => {
    const record = registry.getDocument(id)!;
    return { version: record.summary.version, title: record.summary.title, dirty: record.summary.dirty,
      source: record.source ? id : null, text: record.state.doc };
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const [output, setOutput] = useState<HtmlExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<'html' | 'pdf'>('html');
  const [options, setOptions] = useState<PdfOptions>({ paper: 'a4', landscape: false, marginsMm: { top: 15, right: 15, bottom: 15, left: 15 } });
  const [cancelling, setCancelling] = useState(false);
  const activeRequest = useRef<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); element?.querySelector<HTMLButtonElement>('button')?.focus();
    const controller = new AbortController();
    void (async () => {
      if (snapshot.text.length >= MAX_RENDER_BYTES) throw new Error('文档过大，不能导出不完整内容。');
      const reply = await renderExport({ requestId: crypto.randomUUID(), documentId: id,
        bufferVersion: snapshot.version, source: snapshot.text.toString(), allowHtml }, controller.signal);
      const result = await prepareHtmlExport(reply, { documentId: snapshot.source, directory }, snapshot.title, controller.signal);
      if (!controller.signal.aborted) setOutput(result);
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '导出准备失败。');
    });
    return () => { controller.abort(); element?.close(); };
  }, [snapshot, id, directory, allowHtml]);
  async function save() {
    if (!output || saving) return;
    setSaving(true); setError(null);
    const requestId = crypto.randomUUID(); activeRequest.current = requestId;
    const request = { documentId: id, requestId, documentVersion: snapshot.version, html: output.html };
    const result = format === 'html' ? await previewBridge.exportHtml(request)
      : await previewBridge.exportPdf({ ...request, options });
    setSaving(false);
    setCancelling(false); activeRequest.current = null;
    if (!result.ok) setError(result.error.message);
    else {
      const path = 'metadata' in result.value ? result.value.metadata.displayPath : result.value.displayPath;
      onSaved(`已导出${format.toUpperCase()} · v${snapshot.version}：${path}`);
      onClose();
    }
  }
  function cancel() {
    if (!saving) { onClose(); return; }
    if (format === 'pdf' && activeRequest.current) {
      setCancelling(true);
      void previewBridge.cancelPdf(activeRequest.current).then(result => { if (!result.ok) setError(result.error.message); });
    }
  }
  return <dialog ref={dialog} className="goto-dialog markdown-export-dialog" aria-label="导出 Markdown"
    onCancel={event => { event.preventDefault(); cancel(); }}>
    <header><h2>导出 {format.toUpperCase()}</h2></header>
    <div className="goto-fields">
      <label>格式 <select aria-label="导出格式" value={format} disabled={saving} onChange={event => setFormat(event.currentTarget.value as 'html' | 'pdf')}>
        <option value="html">独立 HTML</option><option value="pdf">PDF 文档</option></select></label>
      {format === 'pdf' && <fieldset disabled={saving}><legend>纸张与页边距</legend>
        <label>纸张 <select aria-label="PDF纸张" value={options.paper} onChange={event => setOptions({ ...options, paper: event.currentTarget.value as PdfOptions['paper'] })}>
          <option value="a4">A4</option><option value="letter">Letter</option></select></label>
        <label><input type="checkbox" checked={options.landscape} onChange={event => setOptions({ ...options, landscape: event.currentTarget.checked })} />横向</label>
        {(['top', 'right', 'bottom', 'left'] as const).map((side, index) => <label key={side}>{['上', '右', '下', '左'][index]}边距（mm）
          <input type="number" aria-label={`PDF${['上', '右', '下', '左'][index]}边距`} min={0} max={50} step={1} value={options.marginsMm[side]}
            onChange={event => setOptions({ ...options, marginsMm: { ...options.marginsMm, [side]: event.currentTarget.valueAsNumber } })} /></label>)}
      </fieldset>}
      <p>{snapshot.title} · v{snapshot.version}{snapshot.dirty ? ' · 当前未保存内容' : ''}</p>
      <p>导出固定快照，保留当前文档的内容与保存状态。</p>
      {registry.getDocument(id)?.summary.version !== snapshot.version && <p role="status">源文档已有新版本，本次仍导出所列快照。</p>}
      {!output && !error && <p role="status">正在准备离线内容与图片…</p>}
      {output && output.failures.length > 0 && <section aria-label="导出缺失资源">
        <p>{output.failures.length}张图片将保留占位，可取消后授权资源目录再重试。</p>
        <ul>{output.failures.slice(0, 100).map((failure, index) => <li key={index}>{failure.label}：{failure.reason}</li>)}</ul>
        {output.failures.length > 100 && <p>仅展示前100项。</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer><button type="button" className="plain-button" disabled={saving && (format !== 'pdf' || cancelling)} onClick={cancel}>{cancelling ? '正在取消…' : '取消'}</button>
      <button type="button" className="primary-button" disabled={!output || saving || format === 'pdf' && Object.values(options.marginsMm).some(value => !Number.isFinite(value) || value < 0 || value > 50)} onClick={() => void save()}>
        {saving ? format === 'pdf' ? '正在生成PDF…' : '正在写入…' : output?.failures.length ? '带占位继续导出…' : '选择位置并导出…'}</button></footer>
  </dialog>;
}

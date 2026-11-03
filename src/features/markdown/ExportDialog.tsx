import { useEffect, useRef, useState } from 'react';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { previewBridge } from '../../bridge/preview';
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
    const result = await previewBridge.exportHtml({ documentId: id, requestId: crypto.randomUUID(),
      documentVersion: snapshot.version, html: output.html });
    setSaving(false);
    if (!result.ok) setError(result.error.message);
    else {
      onSaved(`已导出HTML · v${snapshot.version}：${result.value.metadata.displayPath}`);
      onClose();
    }
  }
  return <dialog ref={dialog} className="goto-dialog markdown-export-dialog" aria-label="导出 Markdown"
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><h2>导出 HTML</h2></header>
    <div className="goto-fields">
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
    <footer><button type="button" className="plain-button" disabled={saving} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={!output || saving} onClick={() => void save()}>
        {saving ? '正在写入…' : output?.failures.length ? '带占位继续导出…' : '选择位置并导出…'}</button></footer>
  </dialog>;
}

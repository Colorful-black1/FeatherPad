import { useEffect, useRef, useState } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { defaultFormatOptions, formatLanguage, formatLanguages, type FormatLanguage, type FormatOptions, type FormatReply, type FormatRequest } from './formatters';

export function FormatDialog({ registry, id, onClose }: { registry: DocumentRegistry; id: DocumentId; onClose: () => void }) {
  const [snapshot] = useState(() => {
    const record = registry.getDocument(id)!;
    const text = record.state.doc.toString();
    return { version: record.summary.version, text, bytes: new TextEncoder().encode(text).byteLength, title: record.summary.title,
      language: formatLanguage(record.summary.languageId, record.summary.displayPath), indent: record.summary.indentWidth,
      mixed: record.summary.format.lineEnding === 'mixed' };
  });
  const [language, setLanguage] = useState<FormatLanguage | null>(snapshot.language);
  const [options, setOptions] = useState<FormatOptions>({ ...defaultFormatOptions, indent: snapshot.indent });
  const [reply, setReply] = useState<FormatReply | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowLarge, setAllowLarge] = useState(false);
  const worker = useRef<Worker | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const large = snapshot.bytes > 2 * 1024 * 1024;
  const stale = registry.getDocument(id)?.summary.version !== snapshot.version;
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { worker.current?.terminate(); clearTimeout(deadline.current); element?.close(); };
  }, []);
  function stop() {
    active.current = null; worker.current?.terminate(); worker.current = null; clearTimeout(deadline.current); setBusy(false);
  }
  function changeOptions(next: FormatOptions) { setOptions(next); setReply(null); setMessage(null); }
  function run() {
    if (!language || stale || large && !allowLarge) return;
    stop(); setReply(null); setMessage(null); setBusy(true);
    const request: FormatRequest = { requestId: crypto.randomUUID(), documentId: id, version: snapshot.version, source: snapshot.text, language, options };
    active.current = request.requestId;
    try {
      worker.current = new Worker(new URL('../../workers/format.worker.ts', import.meta.url), { type: 'module' });
      deadline.current = setTimeout(() => { stop(); setMessage('格式化超过2秒预算，已取消；正文未修改。'); }, 2000);
      worker.current.onerror = () => { stop(); setMessage('格式化器无法启动，正文未修改。'); };
      worker.current.onmessage = (event: MessageEvent<FormatReply>) => {
        const result = event.data;
        if (active.current !== result.requestId || result.documentId !== id || result.version !== snapshot.version) return;
        stop(); setReply(result);
      };
      worker.current.postMessage(request);
    } catch { stop(); setMessage('格式化器无法启动，正文未修改。'); }
  }
  function apply() {
    if (!reply?.ok) return;
    const result = registry.applyTextResult(id, snapshot.version, reply.text);
    if (result.ok) onClose(); else setMessage(result.error.message);
  }
  return <dialog className="text-tool-dialog" ref={dialog} aria-label="格式化文档"
    onCancel={event => { event.preventDefault(); stop(); onClose(); }}>
    <header><h2>格式化文档</h2><span>{snapshot.title} · 全文 · v{snapshot.version}</span></header>
    <div className="text-tool-body">
      <fieldset disabled={busy}><legend>本次格式</legend>
        <label>解析模式 <select aria-label="格式化解析模式" value={language ?? ''} onChange={event => { setLanguage(event.currentTarget.value as FormatLanguage); setReply(null); }}>
          <option value="" disabled>当前语言没有格式化器</option>{formatLanguages.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
        <label>缩进 <select aria-label="格式化缩进" value={options.indent} onChange={event => changeOptions({ ...options, indent: Number(event.currentTarget.value) as FormatOptions['indent'] })}>
          {[2, 4, 8].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><input type="checkbox" checked={options.useTabs} onChange={event => changeOptions({ ...options, useTabs: event.currentTarget.checked })} />Tab缩进</label>
        <label><input type="checkbox" checked={options.singleQuote} onChange={event => changeOptions({ ...options, singleQuote: event.currentTarget.checked })} />JS/TS单引号</label>
        <label><input type="checkbox" checked={options.semi} onChange={event => changeOptions({ ...options, semi: event.currentTarget.checked })} />JS/TS分号</label>
        <label>尾逗号 <select aria-label="格式化尾逗号" value={options.trailingComma} onChange={event => changeOptions({ ...options, trailingComma: event.currentTarget.value as FormatOptions['trailingComma'] })}>
          <option value="preserve">JSONC保留 / Web标准</option><option value="none">移除</option></select></label>
      </fieldset>
      <p>只处理全文语法，不执行代码或项目配置。XML保留内容空白；不支持Java、SCSS/Less或任意模板插件。</p>
      {snapshot.mixed && <p role="note">原有混合换行按顺序保留，新增换行使用原主导类型；一次撤销恢复全部换行标记。</p>}
      {large && <label><input type="checkbox" checked={allowLarge} onChange={event => setAllowLarge(event.currentTarget.checked)} />文档超过2MiB，允许本次生成预览（仍限2秒）</label>}
      {stale && <p role="alert">源文档已变化，请关闭并重新打开格式化；旧结果不会应用。</p>}
      {message && <p role="alert">{message}</p>}
      {reply && !reply.ok && <p role="alert">{reply.diagnostic.message} 行{reply.diagnostic.line}，列{reply.diagnostic.column}
        <button type="button" className="plain-button" onClick={() => {
          if (stale) return; const lines = snapshot.text.split('\n'); const offset = lines.slice(0, reply.diagnostic.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + reply.diagnostic.column - 1;
          onClose(); requestAnimationFrame(() => registry.focusOffset(id, offset));
        }}>定位错误</button></p>}
      {reply?.ok && <section aria-label="格式化预览"><p>{reply.text === snapshot.text ? '内容已符合本次格式。' : `格式化后${reply.text.split('\n').length}行；未写入文档。`}</p>
        <pre tabIndex={0}>{reply.text.slice(0, 40_000)}</pre>{reply.text.length > 40_000 && <p>预览仅展示前40,000字符，应用使用完整结果。</p>}</section>}
    </div>
    <footer><button type="button" className="plain-button" onClick={() => { stop(); onClose(); }}>取消</button>
      {busy ? <button type="button" className="plain-button" onClick={() => { stop(); setMessage('已取消格式化，正文未修改。'); }}>停止生成</button>
        : <button type="button" className="plain-button" disabled={!language || stale || large && !allowLarge} onClick={run}>生成格式预览</button>}
      <button type="button" className="primary-button" disabled={!reply?.ok || stale || busy} onClick={apply}>应用为一次撤销</button></footer>
  </dialog>;
}

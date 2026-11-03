import { useEffect, useRef, useState } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { documentFormat } from '../editor/line-endings';
import { defaultTransformOptions, textOperations, type TextOperation, type TransformOptions, type TransformReply, type TransformRequest } from './text-transforms';

const labels: Record<TextOperation, string> = { sort: '逐行排序', unique: '稳定去重（保留首次）', upper: '转大写', lower: '转小写',
  trim: '清尾空白（空格/Tab）', 'final-newline': '补末尾换行', 'remove-final-newlines': '移除末尾全部换行',
  'tabs-to-spaces': '缩进Tab转空格', 'spaces-to-tabs': '缩进空格转Tab' };

export function TransformPreview({ registry, id, onClose }: { registry: DocumentRegistry; id: DocumentId; onClose: () => void }) {
  const [snapshot] = useState(() => {
    const record = registry.getDocument(id)!, state = record.state;
    const selection = state.selection.main, selected = !selection.empty;
    const from = selected ? selection.from : 0, to = selected ? selection.to : state.doc.length;
    const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
    const text = state.doc.toString(), format = state.field(documentFormat);
    return { text, bytes: new TextEncoder().encode(text).byteLength, version: record.summary.version,
      endings: [...format.endings], insertionEnding: format.insertionEnding, title: record.summary.title,
      language: record.summary.languageId, tabSize: record.summary.indentWidth, from, to,
      scope: `${selected ? '主选区' : '全文'} · ${first.number}:${from - first.from + 1}—${last.number}:${to - last.from + 1}`,
      multiple: state.selection.ranges.length > 1 };
  });
  const [operation, setOperation] = useState<TextOperation>('sort');
  const [options, setOptions] = useState<TransformOptions>({ ...defaultTransformOptions, tabSize: snapshot.tabSize });
  const [reply, setReply] = useState<TransformReply | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowLarge, setAllowLarge] = useState(false);
  const worker = useRef<Worker | null>(null), active = useRef<string | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const stale = registry.getDocument(id)?.summary.version !== snapshot.version;
  useEffect(() => {
    const element = dialog.current; element?.showModal(); element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { worker.current?.terminate(); clearTimeout(deadline.current); element?.close(); };
  }, []);
  function stop() { active.current = null; worker.current?.terminate(); worker.current = null; clearTimeout(deadline.current); setBusy(false); }
  function change(next: TransformOptions) { setOptions(next); setReply(null); setMessage(null); }
  function run() {
    if (stale || snapshot.bytes > 2 * 1024 * 1024 && !allowLarge) return;
    stop(); setReply(null); setMessage(null); setBusy(true);
    const request: TransformRequest = { requestId: crypto.randomUUID(), documentId: id, version: snapshot.version,
      text: snapshot.text, endings: snapshot.endings, insertionEnding: snapshot.insertionEnding,
      from: snapshot.from, to: snapshot.to, operation, options };
    active.current = request.requestId;
    try {
      worker.current = new Worker(new URL('../../workers/transform.worker.ts', import.meta.url), { type: 'module' });
      deadline.current = setTimeout(() => { stop(); setMessage('文本工具超过2秒预算，已停止；正文未修改。'); }, 2000);
      worker.current.onerror = () => { stop(); setMessage('文本工具无法处理本次内容，正文未修改。'); };
      worker.current.onmessage = (event: MessageEvent<TransformReply>) => {
        const result = event.data;
        if (active.current !== result.requestId || result.documentId !== id || result.version !== snapshot.version) return;
        stop(); setReply(result);
      };
      worker.current.postMessage(request);
    } catch { stop(); setMessage('文本工具无法启动，正文未修改。'); }
  }
  function apply() {
    if (!reply?.ok) return;
    const result = registry.applyTextResult(id, snapshot.version, reply.text, reply.endings);
    if (result.ok) onClose(); else setMessage(result.error.message);
  }
  return <dialog ref={dialog} className="text-tool-dialog" aria-label="文本工具预览"
    onCancel={event => { event.preventDefault(); stop(); onClose(); }}>
    <header><h2>文本工具</h2><span>{snapshot.title} · v{snapshot.version}</span></header>
    <div className="text-tool-body"><p aria-label="文本工具范围">{snapshot.scope}</p>
      <p>只处理所列字符范围，首尾行不自动扩展，不自动保存。编码与换行意图保持不变。</p>
      {snapshot.multiple && <p role="note">仅使用主选区；主光标无选区时处理全文，其他选区不参与。</p>}
      <fieldset disabled={busy}><legend>本次变换</legend>
        <label>操作 <select aria-label="文本变换操作" value={operation} onChange={event => { setOperation(event.currentTarget.value as TextOperation); setReply(null); setMessage(null); }}>
          {textOperations.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
        {(operation === 'sort' || operation === 'unique') && <>
          <label><input type="checkbox" checked={options.caseSensitive} onChange={event => change({ ...options, caseSensitive: event.currentTarget.checked })} />区分大小写</label>
          <label><input type="checkbox" checked={options.keepEmpty} onChange={event => change({ ...options, keepEmpty: event.currentTarget.checked })} />保留全部空行</label>
        </>}
        {operation === 'sort' && <>
          <label><input type="checkbox" checked={options.natural} onChange={event => change({ ...options, natural: event.currentTarget.checked })} />自然排序（数字段）</label>
          <label><input type="checkbox" checked={options.descending} onChange={event => change({ ...options, descending: event.currentTarget.checked })} />降序</label>
        </>}
        {(operation === 'tabs-to-spaces' || operation === 'spaces-to-tabs') && <label>Tab宽度 <select aria-label="文本工具Tab宽度" value={options.tabSize} onChange={event => change({ ...options, tabSize: Number(event.currentTarget.value) as TransformOptions['tabSize'] })}>
          {[2, 4, 8].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </fieldset>
      {(operation === 'sort' || operation === 'unique') && <p role="note">按Unicode码点比较，大小写忽略使用固定Unicode小写规则；相等行保持原顺序。换行标记随行移动，末尾换行有无保持原意图；需要新标记时优先复用原标记。</p>}
      {snapshot.language === 'markdown' && <p role="note">Markdown代码、表格和行尾两个空格可能有意义，请核对预览后应用。</p>}
      {snapshot.bytes > 2 * 1024 * 1024 && <label><input type="checkbox" checked={allowLarge} onChange={event => setAllowLarge(event.currentTarget.checked)} />允许本次大文档预览（仍限2秒）</label>}
      {stale && <p role="alert">源文档已有新版本，请关闭并重新生成；旧结果不能应用。</p>}
      {message && <p role="alert">{message}</p>}{reply && !reply.ok && <p role="alert">{reply.message}</p>}
      {reply?.ok && <section aria-label="文本变换结果"><p>{reply.changedLines}个行位置变化；预览尚未应用。</p>
        <pre tabIndex={0}>{reply.replacement.slice(0, 40_000)}</pre>
        {reply.replacement.length > 40_000 && <p>仅展示前40,000字符，应用使用完整结果。</p>}</section>}
    </div>
    <footer><button type="button" className="plain-button" onClick={() => { stop(); onClose(); }}>取消</button>
      {busy ? <button type="button" className="plain-button" onClick={() => { stop(); setMessage('已取消，正文未修改。'); }}>停止生成</button>
        : <button type="button" className="plain-button" disabled={stale || snapshot.bytes > 2 * 1024 * 1024 && !allowLarge} onClick={run}>生成变换预览</button>}
      <button type="button" className="primary-button" disabled={!reply?.ok || stale || busy} onClick={apply}>应用为一次撤销</button></footer>
  </dialog>;
}

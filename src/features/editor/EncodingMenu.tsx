import { useEffect, useRef, useState } from 'react';
import { encodingIds, type EncodingId } from '../../shared/contracts/encoding';
import type { TextFormat } from '../../shared/contracts/files';
import type { DocumentRegistry, DocumentSummary } from './documents';
import { formats, type FormatCoordinator, type FormatPlan } from './format-conversion';
import './encoding.css';

const labels: Record<EncodingId, string> = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE',
  gb18030: 'GB18030', gbk: 'GBK', shift_jis: 'Shift_JIS', big5: 'Big5', 'windows-1252': 'Windows-1252' };
const matchingBom = (encoding: string): TextFormat['bom'] => encoding === 'utf-8' ? 'utf8'
  : encoding === 'utf-16le' ? 'utf16le' : encoding === 'utf-16be' ? 'utf16be' : 'none';

export function EncodingMenu({ registry, summary, blocked, onMessage, coordinator = formats }: {
  registry: DocumentRegistry; summary: DocumentSummary; blocked: boolean; onMessage: (message: string) => void;
  coordinator?: FormatCoordinator;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState(summary.format);
  const [version, setVersion] = useState(summary.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<FormatPlan | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const document = registry.getDocument(summary.id);
  const canConvert = !document?.fragment && !summary.readOnlyReason;
  const canReopen = !!document?.source && document.source.mode !== 'text-preview' && !summary.missing;

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const origin = trigger.current;
    element?.showModal(); cancel.current?.focus();
    return () => { element?.close(); origin?.focus(); };
  }, [open]);

  useEffect(() => {
    if (open && !busy && (plan || confirmReopen)) cancel.current?.focus();
  }, [open, busy, plan, confirmReopen]);

  function show() {
    setFormat({ ...summary.format }); setVersion(summary.version); setError(null); setPlan(null); setConfirmReopen(false); setOpen(true);
  }
  function done(message: string) { setOpen(false); onMessage(message); }
  function current() {
    if (registry.getDocument(summary.id)?.summary.version === version) return true;
    setError('文档已有新修改，请取消并重新打开编码与换行。'); return false;
  }
  function apply(candidate: FormatPlan, acceptLoss: boolean) {
    const result = coordinator.apply(candidate, acceptLoss);
    if (result.ok) done('编码与换行意图已更新，可撤销；保存后才写入文件。');
    else setError(result.error.message);
  }
  async function convert(target = format) {
    if (submitting.current || !current()) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await coordinator.plan(summary.id, target);
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.inspection.lossCount > 0) setPlan(result.value);
      else apply(result.value, false);
    } finally { submitting.current = false; setBusy(false); }
  }
  async function reopen(choice: 'save' | 'discard' | 'clean') {
    if (submitting.current || !current()) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await coordinator.reopen(summary.id, version, format.encoding as EncodingId, choice);
      if (result.ok) done('已按所选编码重新读取磁盘；原文件字节未因重开而改变。');
      else setError(result.error.message);
    } finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <button ref={trigger} type="button" className="plain-button" disabled={blocked || document?.source?.mode === 'text-preview'}
      aria-haspopup="dialog" onClick={show}>编码与换行</button>
    {open && <dialog ref={dialog} className="trash-dialog encoding-dialog" aria-labelledby="encoding-title"
      aria-describedby="encoding-description" onCancel={event => { event.preventDefault(); if (!submitting.current) setOpen(false); }}>
      <header><h2 id="encoding-title">编码与换行</h2></header>
      <div className="trash-body" aria-busy={busy}>
        <p id="encoding-description">重开会重新解释磁盘字节；转换只更改当前文档，保存后才写入文件。</p>
        <div className="encoding-fields">
          <label>目标编码<select aria-label="目标编码" value={format.encoding} disabled={busy || !!plan || confirmReopen}
            onChange={event => {
              const encoding = event.currentTarget.value as EncodingId;
              setFormat({ ...format, encoding, bom: encoding === 'utf-16le' || encoding === 'utf-16be' ? matchingBom(encoding) : 'none' });
            }}>{encodingIds.map(id => <option key={id} value={id}>{labels[id]}</option>)}</select></label>
          <label>BOM<select aria-label="目标BOM" value={format.bom} disabled={busy || !!plan || confirmReopen || matchingBom(format.encoding) === 'none'}
            onChange={event => setFormat({ ...format, bom: event.currentTarget.value as TextFormat['bom'] })}>
            <option value="none">无 BOM</option>{matchingBom(format.encoding) !== 'none'
              && <option value={matchingBom(format.encoding)}>包含 BOM</option>}
          </select></label>
          <label>目标换行<select aria-label="目标换行" value={format.lineEnding} disabled={busy || !!plan || confirmReopen}
            onChange={event => setFormat({ ...format, lineEnding: event.currentTarget.value as TextFormat['lineEnding'] })}>
            <option value="mixed">保留逐行类型（包括孤立 CR）</option><option value="lf">统一 LF</option><option value="crlf">统一 CRLF</option>
          </select></label>
        </div>
        {plan && <section aria-labelledby="encoding-loss-title">
          <h3 id="encoding-loss-title">有 {plan.inspection.lossCount.toLocaleString('zh-CN')} 个字符无法无损表示</h3>
          <p>确认后将这些字符替换为“?”，并改变目标编码。整个转换可以一次撤销。</p>
          <ul>{plan.inspection.samples.map(sample => {
            const line = plan.original.lineAt(sample.offset);
            return <li key={sample.offset}>行 {line.number}，列 {sample.offset - line.from + 1}</li>;
          })}</ul>
          {plan.inspection.lossCount > plan.inspection.samples.length && <p>仅列出前 32 处；确认将替换全部 {plan.inspection.lossCount} 处。</p>}
        </section>}
        {confirmReopen && <p role="alert">当前文档有未保存修改。请先保存，或将当前内容保护到恢复记录后重新读取磁盘。取消会保留当前编辑内容。</p>}
        {busy && <p aria-live="polite">正在核对，请稍候…</p>}
        {error && <p className="trash-error" role="alert">{error}</p>}
      </div>
      <footer>
        <button ref={cancel} type="button" className="plain-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        {plan ? <>
          <button type="button" className="plain-button" disabled={busy} onClick={() => void convert({ ...format, encoding: 'utf-8', bom: 'none' })}>改用 UTF-8</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => apply(plan, true)}>确认替换为 ? 并转换</button>
        </> : confirmReopen ? <>
          <button type="button" className="plain-button" disabled={busy} onClick={() => void reopen('discard')}>保护当前草稿并重开</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void reopen('save')}>保存后重开</button>
        </> : <>
          <button type="button" className="plain-button" disabled={busy || !canReopen} onClick={() => {
            if (!current()) return;
            if (summary.dirty) { setConfirmReopen(true); cancel.current?.focus(); } else void reopen('clean');
          }}>以所选编码重开</button>
          <button type="button" className="primary-button" disabled={busy || !canConvert} onClick={() => void convert()}>应用转换</button>
        </>}
      </footer>
    </dialog>}
  </>;
}

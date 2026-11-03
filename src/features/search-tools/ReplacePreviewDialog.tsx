import { useEffect, useRef, useState } from 'react';
import type {
  ReplaceBatchOutcome,
  ReplacementPlan,
  RollbackBatchOutcome,
} from '../../bridge/replacement';
import type { FileRef } from '../../shared/contracts/files';
import { ReplaceResult } from './ReplaceResult';

function refKey(reference: FileRef) {
  return `${reference.grantId}\0${reference.relativePath}`;
}

export function ReplacePreviewDialog({ plan, busy, error, outcome, rollback, commitUnknown, onCommit, onRollback, onClose }: {
  plan: ReplacementPlan;
  busy: boolean;
  error: string | null;
  outcome: ReplaceBatchOutcome | null;
  rollback: RollbackBatchOutcome | null;
  commitUnknown: boolean;
  onCommit: (selected: readonly FileRef[]) => void;
  onRollback: () => void;
  onClose: () => void;
}) {
  const dialogElement = useRef<HTMLDialogElement>(null);
  const [finalConfirm, setFinalConfirm] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() =>
    new Set(plan.files.filter(file => file.state === 'ready').map(file => refKey(file.ref))));
  const ready = plan.files.filter(file => file.state === 'ready');
  const skipped = plan.files.length - ready.length;
  const selectedFiles = ready.filter(file => selected.has(refKey(file.ref)));
  const selectedMatches = selectedFiles.reduce((total, file) => total + file.matches, 0);
  const hasResult = outcome !== null || rollback !== null;
  const canRollback = outcome !== null && outcome.succeeded.length > 0;

  useEffect(() => {
    const element = dialogElement.current;
    if (element && !element.open) element.showModal();
  }, []);

  function toggle(reference: FileRef) {
    const key = refKey(reference);
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return <dialog ref={dialogElement} className="replace-dialog" aria-labelledby="replace-dialog-title" aria-busy={busy}>
    <header>
      <div>
        <p className="welcome-eyebrow">SAFE REPLACEMENT</p>
        <h2 id="replace-dialog-title">跨文件替换预览</h2>
      </div>
      <button type="button" className="plain-button" disabled={busy} onClick={onClose}>关闭</button>
    </header>
    <div className="replace-summary">
      <strong>{selectedFiles.length} / {ready.length} 个可替换文件已选择</strong>
      <span>{selectedMatches.toLocaleString('zh-CN')} 个替换 · 跳过 {skipped} 个文件</span>
      <span>备份位置：应用数据 / replacement-plans / {plan.planId}</span>
      {plan.truncated && <span className="replace-warning">计划已达到范围上限，不代表工作区结果完整。</span>}
    </div>
    <div className="replace-files" aria-label="替换文件预览">
      {plan.files.length === 0 && <p>没有匹配文件。</p>}
      {plan.files.map(file => {
        const readyFile = file.state === 'ready';
        return <section key={file.id} data-replace-state={file.state}>
          <label>
            <input type="checkbox" checked={readyFile && selected.has(refKey(file.ref))}
              disabled={!readyFile || busy || hasResult} onChange={() => toggle(file.ref)} />
            <span>{file.displayPath}</span>
            <small>{file.matches} 个 · {file.encoding}</small>
          </label>
          {file.reason && <p>{file.reason}</p>}
          <details>
            <summary>查看替换前与替换后</summary>
            <div>
              <pre aria-label={`${file.displayName} 替换前`}>{file.previewBefore}</pre>
              <pre aria-label={`${file.displayName} 替换后`}>{file.previewAfter}</pre>
            </div>
          </details>
        </section>;
      })}
    </div>
    {plan.skipped.length > 0 && <details className="replace-skips">
      <summary>目录遍历跳过与限制</summary>
      <ul>{plan.skipped.map(item => <li key={item}>{item}</li>)}</ul>
    </details>}
    <ReplaceResult outcome={outcome} rollback={rollback} />
    {error && <p className="replace-error" role="alert">{error}</p>}
    {commitUnknown && <div className="replace-unknown" role="alert">
      <strong>写入结果未知，不能视为成功。</strong>
      <p>先检查文件；如已写入，可按批次记录尝试回滚。备份记录不会被删除。</p>
    </div>}
    <footer>
      {!hasResult && !finalConfirm && <button type="button" className="primary-button" disabled={busy || selectedFiles.length === 0}
        onClick={() => setFinalConfirm(true)}>继续到最终确认</button>}
      {!hasResult && finalConfirm && <>
        <div className="replace-final-confirm">
          <strong>最终确认</strong>
          <span>将立即写入 {selectedFiles.length} 个文件，共 {selectedMatches.toLocaleString('zh-CN')} 处替换。取消不会修改任何源文件。</span>
        </div>
        <button type="button" className="plain-button" disabled={busy} onClick={() => setFinalConfirm(false)}>返回检查</button>
        <button type="button" className="danger-button" disabled={busy || selectedFiles.length === 0}
          onClick={() => onCommit(selectedFiles.map(file => file.ref))}>确认替换并写入磁盘</button>
      </>}
      {(canRollback || commitUnknown) && <button type="button" className="plain-button danger-text"
        disabled={busy} onClick={onRollback}>{commitUnknown ? '按批次记录尝试回滚' : '回滚本次替换'}</button>}
      {hasResult && <button type="button" className="primary-button" disabled={busy} onClick={onClose}>完成</button>}
      {busy && <span role="status">正在处理真实文件，请稍候…</span>}
    </footer>
  </dialog>;
}

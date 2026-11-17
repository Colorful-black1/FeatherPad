import { useEffect, useRef, useState } from 'react';
import type {
  ReplaceBatchOutcome,
  ReplaceFileState,
  ReplacementPlan,
  RollbackBatchOutcome,
} from '../../bridge/replacement';
import type { FileRef } from '../../shared/contracts/files';
import { ReplacePreviewHunkView } from './ReplacePreviewHunk';
import { ReplaceResult } from './ReplaceResult';

function refKey(reference: FileRef) {
  return `${reference.grantId}\0${reference.relativePath}`;
}

const stateLabels: Record<ReplaceFileState, string> = {
  ready: '可替换',
  dirtySkipped: '未保存',
  readOnly: '只读',
  conflict: '冲突',
  unsupported: '不支持',
  committed: '已写入',
  rolledBack: '已回滚',
  rollbackConflict: '回滚冲突',
};

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
  const [openPreviews, setOpenPreviews] = useState<Set<string>>(() => new Set());
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

  function selectAll() {
    setSelected(new Set(ready.map(file => refKey(file.ref))));
  }

  function clearAll() {
    setSelected(new Set());
  }

  function setPreviewOpen(id: string, open: boolean) {
    setOpenPreviews(current => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
  }

  return <dialog ref={dialogElement} className="replace-dialog" aria-labelledby="replace-dialog-title" aria-busy={busy}>
    <header>
      <div className="replace-title">
        <p className="welcome-eyebrow">安全替换</p>
        <h2 id="replace-dialog-title">跨文件替换预览</h2>
        <p className="replace-subtitle">先核对行号与替换前后内容，再写入磁盘。</p>
      </div>
      <button type="button" className="plain-button" disabled={busy} onClick={onClose}>关闭</button>
    </header>
    <div className="replace-summary">
      <div className="replace-summary-main">
        <strong>{selectedFiles.length} / {ready.length} 个可替换文件已选择</strong>
        <span>{selectedMatches.toLocaleString('zh-CN')} 处替换</span>
        <span>跳过 {skipped} 个文件</span>
        {plan.truncated && <span className="replace-warning">计划已达到范围上限，不代表工作区结果完整。</span>}
      </div>
      <div className="replace-summary-actions">
        <button type="button" className="plain-button" disabled={busy || hasResult || finalConfirm || ready.length === 0}
          onClick={selectAll}>全选可替换文件</button>
        <button type="button" className="plain-button" disabled={busy || hasResult || finalConfirm || selectedFiles.length === 0}
          onClick={clearAll}>取消全选</button>
      </div>
      <p className="replace-summary-hint">展开文件可查看带行号的替换前后内容；行号基于预览时的文件版本。</p>
      <p className="replace-backup" title={`备份位置：应用数据 / replacement-plans / ${plan.planId}`}>备份：应用数据 / replacement-plans / {plan.planId}</p>
    </div>
    <div className="replace-files" aria-label="替换文件预览">
      {plan.files.length === 0 && <p className="replace-empty">没有匹配文件。</p>}
      {plan.files.map(file => {
        const readyFile = file.state === 'ready';
        const matchLines = file.matchLines ?? [];
        const hunks = file.previewHunks ?? [];
        return <section key={file.id} className="replace-file" data-replace-state={file.state}
          data-selected={readyFile && selected.has(refKey(file.ref)) ? 'true' : undefined}>
          <div className="replace-file-head">
            <label className="replace-file-select">
              <input type="checkbox" checked={readyFile && selected.has(refKey(file.ref))}
                disabled={!readyFile || busy || hasResult || finalConfirm} onChange={() => toggle(file.ref)} />
              <span className="replace-file-copy">
                <strong>{file.displayName}</strong>
                <span className="replace-file-path" title={file.displayPath}>{file.displayPath}</span>
              </span>
            </label>
            <div className="replace-file-meta">
              <span className="replace-count">{file.matches.toLocaleString('zh-CN')} 处</span>
              <span className="replace-encoding">{file.encoding}</span>
              <span className="replace-state" data-state={file.state}>{stateLabels[file.state]}</span>
            </div>
          </div>
          {file.reason && <p className="replace-reason">{file.reason}</p>}
          {matchLines.length > 0 && <div className="replace-match-lines">
            <span className="replace-match-lines-label">替换行</span>
            <ul className="replace-line-chips" aria-label={`${file.displayName} 可替换行`}>
              {matchLines.slice(0, 8).map(line => <li key={line}>第 {line} 行</li>)}
              {matchLines.length > 8 && <li className="replace-line-more"
                title={matchLines.map(line => `第 ${line} 行`).join('、')}>等 {matchLines.length} 行</li>}
            </ul>
          </div>}
          <details className="replace-preview" open={openPreviews.has(file.id)}
            onToggle={event => setPreviewOpen(file.id, event.currentTarget.open)}>
            <summary>{hunks.length > 0
              ? `查看替换前后（第 ${hunks[0]?.startLine ?? 1} 行起，共 ${hunks.length} 段）`
              : '查看替换前后'}</summary>
            {openPreviews.has(file.id) && (hunks.length > 0 ? <div className="replace-hunks">
              {hunks.map((hunk, index) => <ReplacePreviewHunkView key={`${file.id}-${hunk.startLine}-${index}`}
                hunk={hunk} fileName={file.displayName} index={index} count={hunks.length} />)}
            </div> : <div className="replace-legacy">
              <p className="replace-preview-note">{matchLines.length > 0
                ? '此计划未包含可展开的变更片段；请以上方替换行行号为准，以下为文件开头预览。'
                : '此计划未包含行号片段，以下为文件开头预览。'}</p>
              <div className="replace-legacy-panes">
                <pre aria-label={`${file.displayName} 替换前`}>{file.previewBefore}</pre>
                <pre aria-label={`${file.displayName} 替换后`}>{file.previewAfter}</pre>
              </div>
            </div>)}
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

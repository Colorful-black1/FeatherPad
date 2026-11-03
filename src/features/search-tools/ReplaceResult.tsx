import type {
  ReplaceBatchOutcome,
  RollbackBatchOutcome,
} from '../../bridge/replacement';

const statusText = {
  completed: '完成',
  partial: '部分完成',
  failed: '未完成',
} as const;

export function ReplaceResult({ outcome, rollback }: {
  outcome: ReplaceBatchOutcome | null;
  rollback: RollbackBatchOutcome | null;
}) {
  if (!outcome && !rollback) return null;
  return <section className="replace-result" role="status" aria-live="polite">
    {outcome && <>
      <h3>替换{statusText[outcome.status]}</h3>
      <p>{outcome.succeeded.length} 个文件已写入，{outcome.failed.length} 个失败，{outcome.remaining.length} 个未处理。</p>
      {outcome.succeeded.length > 0 && <details>
        <summary>已写入文件</summary>
        <ul>{outcome.succeeded.map(path => <li key={path}>{path}</li>)}</ul>
      </details>}
      {outcome.failed.length > 0 && <details open>
        <summary>失败原因</summary>
        <ul>{outcome.failed.map(message => <li key={message}>{message}</li>)}</ul>
      </details>}
      {outcome.remaining.length > 0 && <details>
        <summary>尚未处理</summary>
        <ul>{outcome.remaining.map(path => <li key={path}>{path}</li>)}</ul>
      </details>}
    </>}
    {rollback && <>
      <h3>回滚{statusText[rollback.status]}</h3>
      <p>{rollback.restored.length} 个文件已恢复，{rollback.conflicts.length} 个冲突，{rollback.failed.length} 个失败。</p>
      {rollback.restored.length > 0 && <details>
        <summary>已恢复原始字节</summary>
        <ul>{rollback.restored.map(path => <li key={path}>{path}</li>)}</ul>
      </details>}
      {rollback.conflicts.length > 0 && <details open>
        <summary>回滚冲突，新内容已保留</summary>
        <ul>{rollback.conflicts.map(path => <li key={path}>{path}</li>)}</ul>
      </details>}
      {rollback.failed.length > 0 && <details open>
        <summary>回滚失败</summary>
        <ul>{rollback.failed.map(message => <li key={message}>{message}</li>)}</ul>
      </details>}
    </>}
  </section>;
}

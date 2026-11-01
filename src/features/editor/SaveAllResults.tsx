import { useSyncExternalStore } from 'react';
import { documents } from './documents';
import { saveAll, type SaveAllItem } from './save-all';

function itemResult(item: SaveAllItem, dirty: boolean) {
  switch (item.status) {
    case 'pending': return '等待保存';
    case 'saving': return '正在保存…';
    case 'unchanged': return '已无修改，跳过保存';
    case 'cancelled': return '已取消保存';
    case 'unprocessed': return '未处理';
    case 'failed': return `保存失败：${item.error.message}`;
    case 'saved': return dirty ? '已保存当时内容；仍有未保存修改' : '已保存';
  }
}

export function SaveAllResults() {
  const batch = useSyncExternalStore(saveAll.subscribe, saveAll.getSnapshot);
  const registry = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  if (batch.phase === 'idle') return null;
  const finished = batch.phase === 'finished';
  const processed = batch.items.filter(item => !['pending', 'saving', 'unprocessed'].includes(item.status)).length;
  const remaining = registry.documents.filter(document => document.dirty).length;
  const summaries = new Map(registry.documents.map(document => [document.id, document]));

  function dismiss() {
    saveAll.dismiss();
    document.getElementById('save-all-button')?.focus();
  }

  return <section className="save-all-results" aria-labelledby="save-all-heading">
    <div className="save-all-heading">
      <h2 id="save-all-heading">全部保存</h2>
      <button className="plain-button" onClick={finished ? dismiss : () => saveAll.cancel()} disabled={batch.phase === 'cancelling'}>
        {finished ? '关闭保存结果' : batch.phase === 'cancelling' ? '等待当前保存结束…' : '停止后续保存'}
      </button>
    </div>
    <p aria-live="polite">{finished ? '本次处理结束' : batch.phase === 'cancelling' ? '正在停止，等待当前保存结果' : '正在逐份保存'}：已处理 {processed} / {batch.items.length} 份。当前仍有 {remaining} 份未保存修改。</p>
    <progress aria-label="全部保存进度" value={processed} max={batch.items.length || 1} />
    <p className="save-all-scope">仅处理开始时有修改的文档。停止后续保存会等待当前写入完成或路径选择关闭。</p>
    <ol aria-label="逐项保存结果">
      {batch.items.map(item => {
        const summary = summaries.get(item.id);
        return <li key={item.id} data-save-result={item.status}>
          <button className="save-all-document" title={summary?.displayPath ?? item.title} onClick={() => {
            documents.activate(item.id);
            document.getElementById(`tab-${item.id}`)?.focus();
          }}>{summary?.title ?? item.title}</button>
          <span>{itemResult(item, summary?.dirty ?? false)}</span>
        </li>;
      })}
    </ol>
  </section>;
}

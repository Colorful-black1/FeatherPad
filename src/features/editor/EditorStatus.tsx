import { useCallback, useSyncExternalStore } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry, DocumentSummary } from './documents';
import { languageLabel } from './editor-language';

export function EditorStatus({ registry, id, summary }: {
  registry: DocumentRegistry;
  id: DocumentId;
  summary: DocumentSummary;
}) {
  const subscribe = useCallback((listener: () => void) => registry.subscribeMetrics(id, listener), [registry, id]);
  const getSnapshot = useCallback(() => registry.getMetrics(id), [registry, id]);
  const metrics = useSyncExternalStore(subscribe, getSnapshot);
  return <span className="editor-metrics" aria-label="编辑状态">
    <span>行 {metrics?.line ?? 1}，列 {metrics?.column ?? 1}</span>
    {metrics && metrics.selectedCharacterCount > 0 &&
      <span>已选 {metrics.selectedCharacterCount.toLocaleString('zh-CN')} 字符{metrics.selectionCount > 1 ? `（${metrics.selectionCount} 处）` : ''}</span>}
    <span>{metrics?.characterCount.toLocaleString('zh-CN') ?? 0} 字符</span>
    <span>{languageLabel(summary.languageId)}{summary.languageSource === 'manual' ? '（手动）' : ''}</span>
  </span>;
}

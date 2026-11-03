import { GFM, parser } from '@lezer/markdown';
import type { DocumentId, ResultEnvelope } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';

export interface MarkdownTask {
  from: number;
  to: number;
  checked: boolean;
  rawLine: string;
}

export function markdownTasks(source: string): MarkdownTask[] {
  const tasks: MarkdownTask[] = [];
  const cursor = parser.configure(GFM).parse(source).cursor();
  do {
    if (cursor.name !== 'TaskMarker') continue;
    const marker = source.slice(cursor.from, cursor.to);
    const item = cursor.node.parent?.parent;
    if (!item || item.name !== 'ListItem' || !/^\[[ xX]\]$/.test(marker)) continue;
    const end = source.indexOf('\n', item.from);
    tasks.push({ from: cursor.from + 1, to: cursor.to - 1, checked: marker[1] !== ' ',
      rawLine: source.slice(item.from, end < 0 ? source.length : end).trim() });
  } while (cursor.next());
  return tasks;
}

export function toggleMarkdownTask(registry: DocumentRegistry, id: DocumentId, version: number,
  task: MarkdownTask): ResultEnvelope<{ version: number }> {
  const record = registry.getDocument(id);
  if (!record || record.summary.version !== version || !Number.isSafeInteger(task.from)
    || task.from < 1 || task.to !== task.from + 1 || task.to >= record.state.doc.length
    || record.state.sliceDoc(task.from - 1, task.to + 1) !== `[${task.checked ? 'x' : ' '}]`
      && !(task.checked && record.state.sliceDoc(task.from - 1, task.to + 1) === '[X]')) {
    return { ok: false, error: { code: 'CONFLICT', message: '任务映射已过期，请等待当前阅读快照。', retryable: true } };
  }
  return registry.replaceRanges(id, version, [{ from: task.from, to: task.to, insert: task.checked ? ' ' : 'x' }]);
}

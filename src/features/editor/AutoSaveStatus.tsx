import { useSyncExternalStore } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import { autoSaves } from './autosave';

export function AutoSaveStatus({ id }: { id: DocumentId }) {
  const paused = useSyncExternalStore(autoSaves.subscribe, autoSaves.getSnapshot).get(id);
  if (!paused) return null;
  return <div className="notice" role="status">自动保存已暂停：{paused.message} 正文仍保留。
    <button className="plain-button" onClick={() => autoSaves.retry(id)}>重试自动保存</button>
  </div>;
}

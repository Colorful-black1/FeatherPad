import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentSummary } from '../editor/documents';

export function OpenEditors({ documents, activeId, busy, onSelect, onClose }: {
  documents: readonly DocumentSummary[]; activeId: DocumentId | null; busy: boolean;
  onSelect: (id: DocumentId) => void; onClose: (id: DocumentId) => void;
}) {
  if (documents.length === 0) return null;
  return <details className="open-editors">
    <summary>已打开的编辑器 <span>{documents.length}</span></summary>
    <ul>
      {documents.map(item => <li key={item.id} data-active={activeId === item.id}>
        <button type="button" className="open-editor-select" onClick={() => onSelect(item.id)}
          aria-description={item.dirty ? '有未保存修改' : '没有未保存修改'}
          aria-current={activeId === item.id ? 'page' : undefined} title={item.displayPath ?? item.title}>
          <span className="open-editor-mark" aria-hidden="true">{item.dirty ? '●' : '◇'}</span>
          <span>{item.title}</span>
        </button>
        <button type="button" className="sidebar-row-action" disabled={busy || item.closing}
          onClick={() => onClose(item.id)} aria-label={`关闭编辑器 ${item.title}`} title="关闭编辑器">×</button>
      </li>)}
    </ul>
  </details>;
}

import type { KeyboardEvent } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentSummary } from './documents';

interface TabStripProps {
  documents: readonly DocumentSummary[];
  activeId: DocumentId | null;
  previewId: DocumentId | null;
  busy: boolean;
  onSelect: (id: DocumentId) => void;
  onPin: (id: DocumentId) => void;
  onClose: (id: DocumentId) => void;
}

export function TabStrip({ documents, activeId, previewId, busy, onSelect, onPin, onClose }: TabStripProps) {
  const names = new Map<string, number>();
  for (const document of documents) names.set(document.title, (names.get(document.title) ?? 0) + 1);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const document = documents[index];
    if (event.key === 'Delete' && document && !busy) { event.preventDefault(); onClose(document.id); return; }
    const count = documents.length;
    const target = event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    const next = target === null ? undefined : documents[target];
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    window.document.getElementById(`tab-${next.id}`)?.focus();
  }

  return <div className="document-tabs" role="tablist" aria-label="打开的文档">
    {documents.map((document, index) => {
      const selected = document.id === activeId;
      const preview = document.id === previewId;
      const parent = (names.get(document.title) ?? 0) > 1 && document.displayPath
        ? document.displayPath.replace(/[\\/][^\\/]+$/, '') : null;
      return <div key={document.id} className="document-tab" role="presentation" data-active={selected}>
        <button id={`tab-${document.id}`} role="tab" aria-selected={selected}
          aria-controls={selected ? `panel-${document.id}` : undefined}
          aria-description={[preview ? '预览标签，双击固定' : '固定标签',
            document.dirty ? '有未保存修改' : '没有未保存修改', document.readOnlyReason ? '只读' : null,
            document.missing ? '原文件当前不可用' : null].filter(Boolean).join('；')}
          tabIndex={selected ? 0 : -1} title={`${document.displayPath ?? document.title}${preview ? '（预览，双击固定）' : ''}`}
          onClick={() => onSelect(document.id)} onDoubleClick={() => onPin(document.id)}
          onKeyDown={event => navigate(event, index)}>
          <span className={`tab-label ${preview ? 'tab-preview' : ''}`}>
            <span>{document.title}</span>{parent && <small>{parent}</small>}
          </span>
          {document.dirty && <span className="dirty-marker" aria-label="有未保存修改">●</span>}
        </button>
        <button type="button" className="tab-close" aria-label={`关闭 ${document.title}${parent ? `，${parent}` : ''}${document.dirty ? '，有未保存修改' : ''}${document.readOnlyReason ? '，只读' : ''}`}
          tabIndex={selected ? 0 : -1} disabled={busy || document.closing}
          title="关闭标签（Ctrl+W）" onClick={() => onClose(document.id)}>×</button>
      </div>;
    })}
  </div>;
}

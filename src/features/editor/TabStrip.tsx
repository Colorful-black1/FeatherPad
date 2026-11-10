import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import { ExplorerContextMenu } from '../workspace/ExplorerContextMenu';
import type { DocumentSummary } from './documents';

export type TabMenuAction = 'close' | 'closeOthers' | 'closeRight' | 'closeAll' | 'copyPath' | 'reveal';

interface PointerDrag {
  id: DocumentId;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

interface TabStripProps {
  documents: readonly DocumentSummary[];
  activeId: DocumentId | null;
  previewId: DocumentId | null;
  busy: boolean;
  onSelect: (id: DocumentId) => void;
  onPin: (id: DocumentId) => void;
  onClose: (id: DocumentId) => void;
  onTabAction?: (action: TabMenuAction, id: DocumentId) => void;
  onReorder?: (ids: readonly DocumentId[]) => void;
}

export function TabStrip({ documents, activeId, previewId, busy, onSelect, onPin, onClose, onTabAction, onReorder }: TabStripProps) {
  const names = new Map<string, number>();
  for (const document of documents) names.set(document.title, (names.get(document.title) ?? 0) + 1);
  const [menu, setMenu] = useState<{ id: DocumentId; x: number; y: number; origin: HTMLElement } | null>(null);
  const [draggingId, setDraggingId] = useState<DocumentId | null>(null);
  const [dropHint, setDropHint] = useState<{ id: DocumentId; edge: 'before' | 'after' } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<PointerDrag | null>(null);
  const suppressClick = useRef(false);

  function edgeAt(clientX: number, rect: DOMRect): 'before' | 'after' {
    return clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  }

  function moveTab(source: DocumentId, target: DocumentId, edge: 'before' | 'after') {
    if (!onReorder || source === target) return;
    const ids = documents.map(document => document.id);
    const from = ids.indexOf(source);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(target);
    if (to < 0) return;
    ids.splice(to + (edge === 'after' ? 1 : 0), 0, source);
    onReorder(ids);
  }

  function dropTargetAt(clientX: number, clientY: number): { id: DocumentId; edge: 'before' | 'after' } | null {
    const element = document.elementFromPoint(clientX, clientY);
    const tab = element?.closest<HTMLElement>('.document-tab');
    const tabId = tab?.dataset.tabId as DocumentId | undefined;
    if (tab && tabId) return { id: tabId, edge: edgeAt(clientX, tab.getBoundingClientRect()) };
    const elementStrip = strip.current;
    if (!elementStrip) return null;
    const bounds = elementStrip.getBoundingClientRect();
    if (clientY < bounds.top || clientY > bounds.bottom) return null;
    const first = documents[0];
    const last = documents.at(-1);
    if (!first || !last) return null;
    const firstTab = document.getElementById(`tab-${first.id}`)?.closest<HTMLElement>('.document-tab');
    if (firstTab && clientX < firstTab.getBoundingClientRect().left) return { id: first.id, edge: 'before' };
    return { id: last.id, edge: 'after' };
  }

  function clearDrag() {
    drag.current = null;
    setDraggingId(null);
    setDropHint(null);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>, document: DocumentSummary) {
    if (!onReorder || busy || event.button !== 0 || event.pointerType === 'touch') return;
    if (event.target instanceof Element && event.target.closest('.tab-close, .tab-pin')) return;
    drag.current = { id: document.id, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, active: false };
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.active) {
      if (Math.abs(event.clientX - state.startX) < 4 && Math.abs(event.clientY - state.startY) < 4) return;
      state.active = true;
      setDraggingId(state.id);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const tabStrip = strip.current;
    if (tabStrip) {
      const bounds = tabStrip.getBoundingClientRect();
      if (event.clientX < bounds.left + 32) tabStrip.scrollLeft -= 14;
      else if (event.clientX > bounds.right - 32) tabStrip.scrollLeft += 14;
    }
    const target = dropTargetAt(event.clientX, event.clientY);
    if (!target || target.id === state.id) {
      setDropHint(null);
      return;
    }
    setDropHint(current => current?.id === target.id && current.edge === target.edge ? current : target);
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.active) {
      suppressClick.current = true;
      if (!cancelled) {
        const target = dropTargetAt(event.clientX, event.clientY);
        if (target) moveTab(state.id, target.id, target.edge);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setTimeout(() => { suppressClick.current = false; }, 0);
    }
    clearDrag();
  }

  function openMenu(document: DocumentSummary, origin: HTMLElement, x: number, y: number) {
    if (!onTabAction) return;
    setMenu({ id: document.id, x, y, origin });
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const document = documents[index];
    if (!document) return;
    if (onReorder && !busy && event.altKey && event.shiftKey
      && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const target = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (target < 0 || target >= documents.length) return;
      event.preventDefault();
      event.stopPropagation();
      const ids = documents.map(item => item.id);
      const [moved] = ids.splice(index, 1);
      if (!moved) return;
      ids.splice(target, 0, moved);
      onReorder(ids);
      requestAnimationFrame(() => window.document.getElementById(`tab-${document.id}`)?.focus());
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openMenu(document, event.currentTarget, bounds.left + 8, bounds.bottom);
      return;
    }
    if (event.key === 'Delete' && !busy) { event.preventDefault(); onClose(document.id); return; }
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

  const menuDocument = menu ? documents.find(document => document.id === menu.id) : undefined;
  const menuIndex = menuDocument ? documents.findIndex(document => document.id === menuDocument.id) : -1;
  const blocked = !!menuDocument && (busy || menuDocument.closing);

  return <>
    <div ref={strip} className="document-tabs" role="tablist" aria-label="打开的文档"
      data-dragging={draggingId !== null}>
      {documents.map((document, index) => {
        const selected = document.id === activeId;
        const preview = document.id === previewId;
        const parent = (names.get(document.title) ?? 0) > 1 && document.displayPath
          ? document.displayPath.replace(/[\\/][^\\/]+$/, '') : null;
        return <div key={document.id} className="document-tab" role="presentation" data-active={selected}
          data-dragging={draggingId === document.id}
          data-drop={dropHint?.id === document.id ? dropHint.edge : undefined}
          data-tab-id={document.id}
          onPointerDown={event => pointerDown(event, document)}
          onPointerMove={pointerMove}
          onPointerUp={event => finishPointer(event)}
          onPointerCancel={event => finishPointer(event, true)}
          onLostPointerCapture={() => {
            const state = drag.current;
            if (state?.active) clearDrag();
          }}
          onPointerLeave={event => {
            const state = drag.current;
            if (state && !state.active && state.pointerId === event.pointerId) drag.current = null;
          }}
          onClickCapture={event => {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
          onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
            if (!onTabAction) return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(document.id);
            const origin = event.currentTarget.querySelector<HTMLElement>('button[role="tab"]') ?? event.currentTarget;
            openMenu(document, origin, event.clientX, event.clientY);
          }}>
          <button id={`tab-${document.id}`} role="tab" aria-selected={selected}
            aria-controls={selected ? `panel-${document.id}` : undefined}
            aria-description={[preview ? '预览标签，双击固定' : '固定标签',
              document.dirty ? '有未保存修改' : '没有未保存修改', document.readOnlyReason ? '只读' : null,
              document.missing ? '原文件当前不可用' : null].filter(Boolean).join('；')}
            tabIndex={selected ? 0 : -1} title={`${document.displayPath ?? document.title}${preview ? '（预览，双击固定）' : ''}`}
            onClick={() => onSelect(document.id)} onDoubleClick={() => onPin(document.id)}
            onKeyDown={event => navigate(event, index)}>
            <span className={`tab-label ${preview ? 'tab-preview' : ''}`}>
              {document.format.encoding === 'binary' && <span aria-hidden="true">▧ </span>}
              <span>{document.title}</span>{parent && <small>{parent}</small>}
            </span>
            {preview && <span className="tab-preview-badge" aria-hidden="true" title="单击其他文件会复用此标签；点击旁边的固定按钮可保留">预览</span>}
            {document.dirty && <span className="dirty-marker" aria-label="有未保存修改">●</span>}
          </button>
          {preview && <button type="button" className="tab-pin" disabled={busy}
            aria-label={`固定 ${document.title}`} title="保留此标签，避免被其他预览替换" onClick={() => onPin(document.id)}>固定</button>}
          <button type="button" className="tab-close" aria-label={`关闭 ${document.title}${parent ? `，${parent}` : ''}${document.dirty ? '，有未保存修改' : ''}${document.readOnlyReason ? '，只读' : ''}`}
            tabIndex={selected ? 0 : -1} disabled={busy || document.closing}
            title="关闭标签（Ctrl+W）" onClick={() => onClose(document.id)}>×</button>
        </div>;
      })}
    </div>
    {menu && menuDocument && onTabAction && <ExplorerContextMenu
      target={{ x: menu.x, y: menu.y, path: menuDocument.displayPath, grantId: null, origin: menu.origin }}
      label="标签操作" onClose={() => setMenu(null)} sections={[
        [{ id: 'close', title: '关闭', binding: 'Ctrl+W', disabledReason: blocked ? '当前有操作正在进行。' : null,
          run: () => onTabAction('close', menuDocument.id) }],
        [
          { id: 'close-others', title: '关闭其他文件', disabledReason: blocked ? '当前有操作正在进行。'
            : documents.length > 1 ? null : '没有其他打开的文件。',
            run: () => onTabAction('closeOthers', menuDocument.id) },
          { id: 'close-right', title: '关闭右侧文件', disabledReason: blocked ? '当前有操作正在进行。'
            : menuIndex >= 0 && menuIndex < documents.length - 1 ? null : '当前标签右侧没有文件。',
            run: () => onTabAction('closeRight', menuDocument.id) },
          { id: 'close-all', title: '关闭所有文件', disabledReason: blocked ? '当前有操作正在进行。' : null,
            run: () => onTabAction('closeAll', menuDocument.id) },
        ],
        [
          { id: 'copy-path', title: '复制路径', disabledReason: menuDocument.displayPath ? null : '未保存的文档没有磁盘路径。',
            run: () => onTabAction('copyPath', menuDocument.id) },
          { id: 'reveal', title: '在文件资源管理器中显示', disabledReason: menuDocument.displayPath && !menuDocument.missing ? null
            : menuDocument.missing ? '原文件当前不可用。' : '未保存的文档没有磁盘路径。',
            run: () => onTabAction('reveal', menuDocument.id) },
        ],
        ...(menuDocument.id === previewId ? [[{ id: 'pin', title: '固定标签',
          run: () => onPin(menuDocument.id) }]] : []),
      ]} />}
  </>;
}

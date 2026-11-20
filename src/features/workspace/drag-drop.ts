import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DirectoryEntry, FileRef, TransferMode } from '../../shared/contracts/files';

export const workspaceDragType = 'application/x-featherpad-entry';

export interface WorkspaceDragPayload {
  grantId: string;
  relativePath: string;
  revision: string;
}

export function dragPayload(entry: DirectoryEntry): WorkspaceDragPayload {
  return {
    grantId: entry.ref.grantId,
    relativePath: entry.ref.relativePath,
    revision: entry.revision,
  };
}

export function parseDragPayload(text: string): WorkspaceDragPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    if (typeof item.grantId !== 'string' || !item.grantId
      || typeof item.relativePath !== 'string' || !item.relativePath
      || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/i.test(item.revision)) return null;
    return item as unknown as WorkspaceDragPayload;
  } catch {
    return null;
  }
}

export function transferMode(copyRequested: boolean): TransferMode {
  return copyRequested ? 'copy' : 'move';
}

export function transferConfirmation(source: DirectoryEntry, targetName: string, mode: TransferMode) {
  return mode === 'copy'
    ? `将“${source.name}”复制到“${targetName}”？目标已存在时不会覆盖。`
    : `将“${source.name}”移动到“${targetName}”？目标已存在时不会覆盖。`;
}

/** A drop onto the current parent is a no-op for moves and a name conflict for copies. */
export function canTransferEntry(source: DirectoryEntry, target: FileRef): boolean {
  if (source.kind === 'junction' || source.kind === 'symlink') return false;
  if (target.relativePath === source.ref.relativePath) return false;
  if (target.relativePath.startsWith(`${source.ref.relativePath}/`)) return false;
  const parentPath = source.ref.relativePath.split('/').slice(0, -1).join('/');
  return target.grantId !== source.ref.grantId || target.relativePath !== parentPath;
}

interface WorkspaceDropTarget {
  element: HTMLElement;
  reference: FileRef;
  name: string;
}

interface PointerDragOptions {
  canDrop: (target: FileRef) => boolean;
  onDrop: (target: FileRef, targetName: string, mode: TransferMode) => void;
}

const DRAG_THRESHOLD = 5;
const CLICK_SUPPRESS_MS = 500;
let suppressClickUntil = 0;

/** Consumes the synthetic click that follows a completed pointer drag. */
export function consumeWorkspaceDragClick(): boolean {
  if (performance.now() >= suppressClickUntil) return false;
  suppressClickUntil = 0;
  return true;
}

function dropTargetAt(x: number, y: number): WorkspaceDropTarget | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-entry-drop-grant]');
  if (!element || element.dataset.entryDropKind !== 'directory') return null;
  const grantId = element.dataset.entryDropGrant;
  if (!grantId) return null;
  return {
    element,
    reference: { grantId: grantId as FileRef['grantId'], relativePath: element.dataset.entryDropPath ?? '' },
    name: element.dataset.entryDropName ?? '',
  };
}

function clearDropHighlight(target: HTMLElement | null) {
  if (target) delete target.dataset.dragOver;
}

/**
 * WebView2's native file-drop handler, which Tauri enables by default on
 * Windows, replaces the HTML5 drag-and-drop pipeline. Track the pointer
 * ourselves so moving workspace entries works in the real window while native
 * file drops keep working.
 */
export function beginWorkspacePointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  entry: DirectoryEntry,
  options: PointerDragOptions,
) {
  if (event.button !== 0 || !event.isPrimary) return;
  const origin = event.currentTarget;
  const scroller = origin.closest<HTMLElement>('.explorer-scroll');
  const startX = event.clientX;
  const startY = event.clientY;
  let x = startX;
  let y = startY;
  let active = false;
  let ghost: HTMLDivElement | null = null;
  let highlighted: HTMLElement | null = null;
  let frame = 0;

  function updateHighlight() {
    const candidate = dropTargetAt(x, y);
    const next = candidate && options.canDrop(candidate.reference) ? candidate.element : null;
    if (next !== highlighted) {
      clearDropHighlight(highlighted);
      highlighted = next;
      if (highlighted) highlighted.dataset.dragOver = 'true';
    }
  }

  function tick() {
    if (!active) return;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (y < bounds.top + 32) scroller.scrollTop -= 12;
      else if (y > bounds.bottom - 32) scroller.scrollTop += 12;
      updateHighlight();
    }
    frame = requestAnimationFrame(tick);
  }

  function cleanup() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('blur', cancel);
    document.body.classList.remove('workspace-entry-dragging');
    clearDropHighlight(highlighted);
    ghost?.remove();
    if (frame) cancelAnimationFrame(frame);
  }

  function begin() {
    active = true;
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    document.body.classList.add('workspace-entry-dragging');
    ghost = document.createElement('div');
    ghost.className = 'tree-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = entry.name;
    document.body.append(ghost);
    frame = requestAnimationFrame(tick);
  }

  function move(pointerEvent: PointerEvent) {
    x = pointerEvent.clientX;
    y = pointerEvent.clientY;
    if (!active) {
      if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
      begin();
    }
    if (ghost) {
      ghost.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
      const label = pointerEvent.ctrlKey ? `复制 ${entry.name}` : entry.name;
      if (ghost.textContent !== label) ghost.textContent = label;
    }
    updateHighlight();
  }

  function finish(pointerEvent: PointerEvent, cancelled: boolean) {
    const dropped = !cancelled && active ? dropTargetAt(pointerEvent.clientX, pointerEvent.clientY) : null;
    const accepted = dropped && options.canDrop(dropped.reference) ? dropped : null;
    cleanup();
    if (accepted) {
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
      options.onDrop(accepted.reference, accepted.name, transferMode(pointerEvent.ctrlKey));
    }
  }

  function up(pointerEvent: PointerEvent) {
    finish(pointerEvent, false);
  }

  function cancel() {
    cleanup();
  }

  function keydown(keyEvent: KeyboardEvent) {
    if (keyEvent.key === 'Escape' && active) {
      keyEvent.preventDefault();
      cleanup();
    }
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', keydown);
  window.addEventListener('blur', cancel);
}

let dragging: WorkspaceDragPayload | null = null;

export function startWorkspaceDrag(entry: DirectoryEntry) { dragging = dragPayload(entry); }
export function clearDropTarget(element: HTMLElement) { delete element.dataset.dragOver; }
export function endWorkspaceDrag() {
  dragging = null;
  document.querySelectorAll<HTMLElement>('[data-drag-over]').forEach(clearDropTarget);
}
export function highlightDropTarget(event: DragEvent<HTMLElement>, target: FileRef) {
  const sameRoot = dragging?.grantId === target.grantId;
  const descendant = sameRoot && (target.relativePath === dragging?.relativePath
    || target.relativePath.startsWith(`${dragging?.relativePath}/`));
  const sameParent = sameRoot && !event.ctrlKey && target.relativePath === dragging?.relativePath.split('/').slice(0, -1).join('/');
  if (dragging && !descendant && !sameParent && event.dataTransfer.types.includes(workspaceDragType)) event.currentTarget.dataset.dragOver = 'true';
  else clearDropTarget(event.currentTarget);
}

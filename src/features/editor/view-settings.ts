export type FontZoomAction = 'in' | 'out' | 'reset';

export function fontSizeAfterZoom(current: number, action: FontZoomAction): number {
  return action === 'reset' ? 14 : Math.max(8, Math.min(40, current + (action === 'in' ? 1 : -1)));
}

export function listenEditorFontWheel(target: Window, zoom: (action: FontZoomAction) => void, blocked: () => boolean) {
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !Number.isFinite(event.deltaY) || event.deltaY === 0 || blocked()
      || target.document.querySelector('dialog[open]')
      || !(event.target instanceof Element) || !event.target.closest('.document-view')) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 'in' : 'out');
  };
  target.addEventListener('wheel', onWheel, { passive: false });
  return () => target.removeEventListener('wheel', onWheel);
}

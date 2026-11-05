import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { MenuAction } from '../../shared/ui/MenuBar';

export interface ExplorerMenuTarget {
  x: number;
  y: number;
  path: string | null;
  grantId: string | null;
  origin: HTMLElement;
}

export function ExplorerContextMenu({ target, sections, onClose }: {
  target: ExplorerMenuTarget;
  sections: readonly (readonly MenuAction[])[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [target]);

  useEffect(() => {
    function outside(event: Event) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  function restoreFocus() {
    if (target.origin.isConnected) target.origin.focus();
  }

  return createPortal(<div ref={menu} role="menu" aria-label="资源管理器操作"
    className="menu-popup explorer-context-menu" style={{ left: target.x, top: target.y }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); onClose(); restoreFocus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = items.findIndex(item => item === document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    {sections.map((section, index) => <div role="group" key={index}>
      {index > 0 && <div role="separator" className="menu-separator" />}
      {section.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1} aria-label={action.title}
        className="menu-action" aria-disabled={!!action.disabledReason} title={action.disabledReason ?? undefined}
        onClick={() => {
          if (action.disabledReason) return;
          onClose(); restoreFocus(); action.run?.();
        }}><span>{action.title}</span>{action.binding && <kbd>{action.binding}</kbd>}</button>)}
    </div>)}
  </div>, document.body);
}

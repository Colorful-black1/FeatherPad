import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuAction {
  id: string;
  title: string;
  binding?: string | null;
  disabledReason?: string | null;
  run?: () => void;
}

export interface MenuGroup {
  id?: string;
  title: string;
  sections: readonly (readonly MenuAction[])[];
}

export function MenuBar({ groups, onPick }: { groups: readonly MenuGroup[]; onPick: (id: string) => void }) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    }
    function trackFocus(event: FocusEvent) {
      if (event.target instanceof HTMLElement && !root.current?.contains(event.target)) {
        origin.current = event.target;
        setOpen(null);
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', trackFocus);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', trackFocus);
    };
  }, []);

  function focusItem(group: number, last = false) {
    setOpen(group);
    setActive(group);
    requestAnimationFrame(() => {
      const items = root.current?.querySelectorAll<HTMLButtonElement>(`[data-menu="${group}"] [role="menuitem"]`);
      items?.[last ? items.length - 1 : 0]?.focus();
    });
  }

  function navigate(event: KeyboardEvent, group: number) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    const inPopup = event.target instanceof Element && !!event.target.closest('[role="menu"]');
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      setOpen(null); triggers.current[group]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(null);
      triggers.current[group]?.focus();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = (group + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
      setActive(next);
      if (open !== null) focusItem(next); else triggers.current[next]?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!inPopup) { focusItem(group, event.key === 'ArrowUp' || event.key === 'End'); return; }
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>(`[data-menu="${group}"] [role="menuitem"]`) ?? [])];
      const current = items.indexOf(event.target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  function pick(action: MenuAction, group: number) {
    if (action.disabledReason) return;
    setOpen(null);
    // Restore the editor before running commands so selections, undo and dialog
    // return focus use the same origin as keyboard shortcuts.
    const target = origin.current?.isConnected && origin.current.getClientRects().length > 0 ? origin.current
      : document.querySelector<HTMLElement>('.cm-content') ?? triggers.current[group];
    target?.focus();
    if (action.run) action.run(); else onPick(action.id);
  }

  return <nav ref={root} className="menu-bar" role="menubar" aria-label="主菜单">
    {groups.map((group, index) => <div className="menu-group" key={group.title}
      onKeyDown={event => navigate(event, index)}
      onMouseEnter={() => { if (open !== null && open !== index) focusItem(index); }}>
      <button ref={element => { triggers.current[index] = element; }} type="button" role="menuitem"
        id={group.id ?? `${id}-trigger-${index}`} aria-haspopup="menu" aria-expanded={open === index}
        aria-controls={open === index ? `${id}-popup-${index}` : undefined}
        tabIndex={active === index ? 0 : -1} className="menu-trigger"
        onFocus={() => setActive(index)}
        onClick={() => { if (open === index) setOpen(null); else focusItem(index); }}>
        {group.title}
      </button>
      {open === index && <div id={`${id}-popup-${index}`} data-menu={index}
        className="menu-popup" role="menu" aria-labelledby={group.id ?? `${id}-trigger-${index}`}>
        {group.sections.map((section, sectionIndex) => <div role="group" key={sectionIndex}>
          {sectionIndex > 0 && <div role="separator" className="menu-separator" />}
          {section.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1}
            className="menu-action" aria-label={action.title} aria-disabled={!!action.disabledReason}
            title={action.disabledReason ?? undefined} onClick={() => pick(action, index)}>
            <span>{action.title}</span>{action.binding && <kbd>{action.binding}</kbd>}
          </button>)}
        </div>)}
      </div>}
    </div>)}
  </nav>;
}

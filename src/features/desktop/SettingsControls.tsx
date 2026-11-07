import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface SettingsOption {
  value: string;
  label: string;
}

interface PopupProps {
  id: string;
  label: string;
  options: readonly SettingsOption[];
  value: string;
  active: number;
  onActive: (index: number) => void;
  onChoose: (index: number) => void;
  popup: { current: HTMLDivElement | null };
}

function usePopupDismiss(open: boolean, field: { current: HTMLElement | null },
  popup: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      if (event.target instanceof Node && !field.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      close();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, field, popup, close]);
}

function placePopup(trigger: HTMLElement, popup: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  popup.style.minWidth = `${Math.max(rect.width, 180)}px`;
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 4;
  popup.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 4)}px`;
}

function usePopupPosition(open: boolean, trigger: { current: HTMLElement | null },
  popup: { current: HTMLElement | null }) {
  useLayoutEffect(() => {
    if (!open) return;
    const triggerElement = trigger.current;
    const element = popup.current;
    if (!triggerElement || !element) return;
    placePopup(triggerElement, element);
  }, [open, trigger, popup]);
}

function OptionPopup({ id, label, options, value, active, onActive, onChoose, popup }: PopupProps) {
  useEffect(() => {
    popup.current?.querySelector<HTMLElement>(`[data-active="true"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, popup]);
  return <div ref={popup} id={id} role="listbox" aria-label={label} className="settings-option-popup">
    {options.length === 0 && <p className="settings-option-empty">没有匹配的本机字体；可直接使用输入值。</p>}
    {options.map((option, index) => <button key={option.value} type="button" role="option" tabIndex={-1}
      id={`${id}-${index}`} aria-selected={option.value === value} data-active={index === active}
      className="settings-option" onMouseEnter={() => onActive(index)} onMouseDown={event => event.preventDefault()}
      onClick={() => onChoose(index)}>
      <span>{option.label}</span>{option.value === value && <span className="settings-option-check" aria-hidden="true">✓</span>}
    </button>)}
  </div>;
}

function moveActive(event: KeyboardEvent<HTMLElement>, active: number, count: number) {
  if (count === 0) return null;
  if (event.key === 'ArrowDown') return (active + 1) % count;
  if (event.key === 'ArrowUp') return (active + count - 1) % count;
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return count - 1;
  return null;
}

export function SettingsSelect({ id, label, value, options, onChange, invalid, describedBy }: {
  id?: string; label: string; value: string; options: readonly SettingsOption[];
  onChange: (value: string) => void; invalid?: boolean; describedBy?: string | undefined;
}) {
  const field = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const selected = options.find(option => option.value === value);
  usePopupDismiss(open, field, popup, close);
  usePopupPosition(open, trigger, popup);

  function show() {
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
    requestAnimationFrame(() => trigger.current?.focus());
  }

  function keydown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const next = moveActive(event, active, options.length);
    if (next !== null) { event.preventDefault(); setActive(next); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); return; }
    if (event.key === 'Tab') close();
  }

  return <div ref={field} className="settings-select-wrap">
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
      aria-invalid={invalid || undefined} aria-describedby={describedBy} className="settings-select"
      onClick={() => open ? close() : show()} onKeyDown={keydown}>
      <span>{selected?.label ?? value}</span><span className="settings-select-chevron" aria-hidden="true">▾</span>
    </button>
    {open && <OptionPopup id={listId} label={label} options={options} value={value} active={active}
      onActive={setActive} onChoose={choose} popup={popup} />}
  </div>;
}

export function SettingsFontPicker({ id, label, value, options, onChange, invalid, describedBy }: {
  id?: string; label: string; value: string; options: readonly string[];
  onChange: (value: string) => void; invalid?: boolean; describedBy?: string | undefined;
}) {
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => { setOpen(false); setQuery(null); }, []);
  usePopupDismiss(open, field, popup, close);
  usePopupPosition(open, input, popup);

  // Show every installed font while the popup opens. Only filter once the user
  // starts typing, which fixes the one-item datalist bug.
  const visible = useMemo(() => {
    const values = options.map(name => ({ value: name, label: name }));
    if (query === null || query === value) return values;
    const needle = query.trim().toLocaleLowerCase();
    return needle ? values.filter(option => option.label.toLocaleLowerCase().includes(needle)) : values;
  }, [options, query, value]);
  const text = query ?? value;

  function show() {
    setQuery(null);
    setActive(Math.max(0, visible.findIndex(option => option.value === value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = visible[index];
    if (!option) return;
    onChange(option.value);
    close();
    requestAnimationFrame(() => input.current?.focus());
  }

  function keydown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const next = moveActive(event, active, visible.length);
    if (next !== null) { event.preventDefault(); setActive(next); return; }
    if (event.key === 'Enter') { event.preventDefault(); choose(active); return; }
    if (event.key === 'Tab') close();
  }

  return <div ref={field} className="settings-font-picker">
    <input ref={input} id={id} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
      aria-invalid={invalid || undefined} aria-describedby={describedBy} autoComplete="off" spellCheck={false}
      value={text} onClick={() => { if (!open) show(); }} onKeyDown={keydown}
      onChange={event => {
        setQuery(event.currentTarget.value);
        setActive(0);
        onChange(event.currentTarget.value);
      }} />
    <button type="button" className="settings-font-toggle" aria-label={`展开${label}列表`} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => open ? close() : show()}>
      <span aria-hidden="true">▾</span>
    </button>
    {open && <OptionPopup id={listId} label={label} options={visible} value={value} active={active}
      onActive={setActive} onChoose={choose} popup={popup} />}
  </div>;
}

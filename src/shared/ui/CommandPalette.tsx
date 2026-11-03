import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandItem, CommandResult } from '../commands/registry';
import { shortcutForEvent } from '../commands/keyboard';

export interface PaletteItem extends CommandItem { detail?: string }
interface CommandPaletteProps {
  mode: 'commands' | 'files';
  items: readonly PaletteItem[];
  scope?: string;
  onPick: (id: string) => void;
  onClose: () => void;
  onBind?: (id: string, value: string | null) => CommandResult;
  onResetBindings?: () => void;
  onImportBindings?: (text: string) => CommandResult;
  onExportBindings?: () => string;
}

export function CommandPalette({
  mode, items, scope, onPick, onClose, onBind, onResetBindings, onImportBindings, onExportBindings,
}: CommandPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const bindingInput = useRef<HTMLInputElement>(null);
  const importing = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [binding, setBinding] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = items.filter(item => tokens.every(token => `${item.title} ${item.detail ?? ''} ${item.keywords} ${item.id}`.toLocaleLowerCase().includes(token)));
  const visible = matching.slice(0, 200);
  const index = Math.max(0, visible.findIndex(item => item.id === selectedId));
  const selected = visible[index];
  const title = mode === 'commands' ? '命令面板' : '快速打开';

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    input.current?.focus();
    return () => element.close();
  }, []);
  useEffect(() => {
    if (editing) bindingInput.current?.focus();
    else input.current?.focus();
  }, [editing]);
  useEffect(() => {
    window.document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, listId, query]);

  function pick(item: PaletteItem | undefined) {
    if (!item) { setMessage('没有可执行的结果。'); return; }
    if (item.disabledReason) { setMessage(item.disabledReason); return; }
    onPick(item.id);
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); pick(selected); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const next = visible[(index + visible.length + (event.key === 'ArrowDown' ? 1 : -1)) % visible.length];
    if (next) { setSelectedId(next.id); setMessage(null); }
  }

  function updateBinding(value: string | null) {
    if (!selected || !onBind) return;
    const result = onBind(selected.id, value);
    setMessage(result.ok ? '快捷键已更新。' : result.reason);
    if (result.ok) setEditing(false);
  }

  function exportBindings() {
    if (!onExportBindings) return;
    const url = URL.createObjectURL(new Blob([onExportBindings()], { type: 'application/json' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = 'featherpad-shortcuts.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage('快捷键配置已导出。');
  }

  async function importBindings(file: File | undefined) {
    if (!file || !onImportBindings) return;
    if (file.size > 65_536) { setMessage('快捷键文件超过64KiB，原配置未改变。'); return; }
    const result = onImportBindings(await file.text());
    setMessage(result.ok ? '快捷键配置已导入。' : result.reason);
  }

  return <dialog ref={dialog} className="command-palette" aria-labelledby={`${listId}-title`}
    onCancel={event => { event.preventDefault(); if (editing) setEditing(false); else onClose(); }}>
    <header>
      <h2 id={`${listId}-title`}>{title}</h2>
      <button type="button" className="plain-button" aria-label={`关闭${title}`} onClick={onClose}>关闭 <kbd>Esc</kbd></button>
    </header>
    <div className="palette-search">
      <label className="visually-hidden" htmlFor={`${listId}-input`}>{mode === 'commands' ? '搜索命令' : '搜索文件'}</label>
      <input ref={input} id={`${listId}-input`} role="combobox" aria-autocomplete="list" aria-expanded="true"
        aria-controls={`${listId}-list`} aria-activedescendant={selected ? `${listId}-${index}` : undefined}
        autoComplete="off" spellCheck={false} maxLength={256} value={query} placeholder={mode === 'commands' ? '搜索命令名称或关键词…' : '输入文件名或路径…'}
        disabled={editing} onChange={event => { setQuery(event.currentTarget.value); setSelectedId(null); setMessage(null); }} onKeyDown={navigate} />
      {scope && <p>{scope}</p>}
    </div>
    <ul id={`${listId}-list`} role="listbox" aria-label={`${title}结果`} className="palette-results">
      {visible.map((item, itemIndex) => <li key={item.id} id={`${listId}-${itemIndex}`} role="option"
        aria-selected={index === itemIndex} aria-disabled={!!item.disabledReason || editing}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (!editing) setSelectedId(item.id); }}
        onClick={() => { if (!editing) pick(item); }}>
        <span className="palette-item-copy"><span>{item.title}</span>
          {item.detail && <small>{item.detail}</small>}{item.disabledReason && <small>{item.disabledReason}</small>}</span>
        {mode === 'commands' && <kbd>{item.binding ?? '未绑定'}</kbd>}
      </li>)}
    </ul>
    {matching.length === 0 && <p className="palette-empty">没有匹配的{mode === 'commands' ? '命令' : '文件'}。</p>}
    {matching.length > 200 && <p className="palette-hint">显示前200项，共{matching.length}项匹配；请继续输入缩小范围。</p>}
    <footer>
      {editing && selected ? <form className="palette-binding" onSubmit={event => { event.preventDefault(); updateBinding(binding); }}>
        <label htmlFor={`${listId}-binding`}>“{selected.title}”的快捷键</label>
        <input ref={bindingInput} id={`${listId}-binding`} aria-label="快捷键组合" maxLength={64} value={binding}
          onChange={event => setBinding(event.currentTarget.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || ['Tab', 'Escape', 'Enter'].includes(event.key)) return;
            const next = shortcutForEvent(event.nativeEvent);
            if (next) { event.preventDefault(); event.stopPropagation(); setBinding(next); }
          }} />
        <button type="submit" className="primary-button">应用快捷键</button>
        <button type="button" className="plain-button" onClick={() => updateBinding(null)}>解除绑定</button>
        <button type="button" className="plain-button" onClick={() => setEditing(false)}>返回命令</button>
      </form> : <>
        <span className="palette-hint">↑ ↓ 选择 · Enter {mode === 'commands' ? '执行' : '打开'} · Esc 关闭</span>
        {mode === 'commands' && onBind && <button type="button" className="plain-button" disabled={!selected}
          onClick={() => { setBinding(selected?.binding ?? ''); setMessage(null); setEditing(true); }}>修改快捷键</button>}
        {mode === 'commands' && onResetBindings && <button type="button" className="plain-button" onClick={() => { onResetBindings(); setMessage('已恢复全部默认快捷键。'); }}>恢复默认快捷键</button>}
        {mode === 'commands' && onImportBindings && <>
          <input ref={importing} type="file" accept=".json,application/json" hidden aria-label="导入快捷键文件"
            onChange={event => { void importBindings(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          <button type="button" className="plain-button" onClick={() => importing.current?.click()}>导入快捷键…</button>
        </>}
        {mode === 'commands' && onExportBindings && <button type="button" className="plain-button" onClick={exportBindings}>导出快捷键…</button>}
      </>}
      {message && <p className="palette-message" role="alert">{message}</p>}
    </footer>
  </dialog>;
}

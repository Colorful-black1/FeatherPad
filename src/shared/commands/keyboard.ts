export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

const editorBindings = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z',
  'Ctrl+I', 'Ctrl+Shift+K', 'Ctrl+U', 'Alt+U', 'Alt+L', 'Alt+A', 'Shift+Alt+A', 'Ctrl+M']);
const systemBindings = new Set(['Alt+F4', 'Shift+Alt+F4', 'Alt+Tab', 'Shift+Alt+Tab', 'Alt+Escape', 'Shift+Alt+Escape',
  'Ctrl+Escape', 'Ctrl+Shift+Escape', 'F10', 'Shift+F10']);

export function normalizeShortcut(value: string): string | null {
  if (value.length > 64) return null;
  const parts = value.trim().split('+').map(part => part.trim().toLowerCase());
  const last = parts.pop();
  const key = last === ',' ? ',' : last && /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|escape)$/.test(last)
    ? last.length === 1 ? last.toUpperCase() : last === 'tab' ? 'Tab' : last === 'escape' ? 'Escape' : last.toUpperCase() : null;
  if (!key) return null;
  const modifiers = parts.map(part => part === 'control' ? 'ctrl' : part);
  if (new Set(modifiers).size !== modifiers.length || modifiers.some(part => !['ctrl', 'shift', 'alt'].includes(part))) return null;
  if (!modifiers.includes('ctrl') && !modifiers.includes('alt') && !/^F\d+$/.test(key)) return null;
  return [...(modifiers.includes('ctrl') ? ['Ctrl'] : []), ...(modifiers.includes('shift') ? ['Shift'] : []),
    ...(modifiers.includes('alt') ? ['Alt'] : []), key].join('+');
}

export function shortcutRestriction(binding: string): string | null {
  if (editorBindings.has(binding)) return '此组合键保留给原生文本编辑。';
  if (systemBindings.has(binding)) return '此组合键保留给 Windows。';
  if (binding.includes('Ctrl+') && binding.includes('Alt+')) return 'Ctrl+Alt 组合可能用于 AltGr 输入，请选择其他组合。';
  return null;
}

export function shortcutForEvent(event: ShortcutEvent): string | null {
  if (event.metaKey || event.isComposing || event.key === 'Process' || event.key === 'Dead') return null;
  return normalizeShortcut(`${event.ctrlKey ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Alt+' : ''}${event.key}`);
}

export const ariaShortcut = (binding: string | null) => binding?.replace('Ctrl+', 'Control+') ?? undefined;

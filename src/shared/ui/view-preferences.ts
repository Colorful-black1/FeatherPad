export type MarkdownMode = 'source' | 'read' | 'split';

interface Preference<T> { value: T; warning: string | null }
const sidebarKey = 'featherpad.view.sidebar-width.v1';
const markdownKey = 'featherpad.view.markdown-mode.v1';
export const sidebarMinWidth = 180;
export const sidebarMaxWidth = 640;
export const sidebarDefaultWidth = 232;

function read(key: string): Preference<string | null> {
  try { return { value: window.localStorage.getItem(key), warning: null }; }
  catch { return { value: null, warning: '无法读取界面偏好，已使用默认布局。' }; }
}

export function loadSidebarWidth(): Preference<number> {
  const stored = read(sidebarKey);
  if (stored.value === null) return { ...stored, value: sidebarDefaultWidth };
  const width = stored.value.length <= 16 ? Number(stored.value) : NaN;
  return Number.isInteger(width) && width >= sidebarMinWidth && width <= sidebarMaxWidth
    ? { value: width, warning: null }
    : { value: sidebarDefaultWidth, warning: '侧栏宽度记录无效，已恢复默认宽度。' };
}

export function loadMarkdownMode(): Preference<MarkdownMode> {
  const stored = read(markdownKey);
  if (stored.value === null) return { ...stored, value: 'source' };
  return stored.value === 'source' || stored.value === 'read' || stored.value === 'split'
    ? { value: stored.value, warning: null }
    : { value: 'source', warning: 'Markdown视图记录无效，已使用源码模式。' };
}

function save(key: string, value: string): string | null {
  try { window.localStorage.setItem(key, value); return null; }
  catch { return '界面偏好未能保存，本次调整仍然有效；下次打开可能使用旧布局。'; }
}

export function saveSidebarWidth(width: number) { return save(sidebarKey, String(width)); }
export function saveMarkdownMode(mode: MarkdownMode) { return save(markdownKey, mode); }

import { isRawSettings, type JsonValue, type RawSettings } from '../../shared/contracts/settings';
export { isRawSettings } from '../../shared/contracts/settings';
import type { ResultEnvelope } from '../../shared/contracts/files';
import { normalizeShortcut, shortcutRestriction } from '../../shared/commands/keyboard';
import { recentHistoryItemsSetting } from '../workspace/recent';
import { favoritesSetting } from '../workspace/favorites';

export const languagePreferencesSetting = 'documentLanguagePreferences';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: 2 | 4 | 8;
  insertSpaces: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  whitespaceMode: 'none' | 'current' | 'all';
  folding: boolean;
  autoSave: boolean;
  markdownAllowHtml: boolean;
  recentHistoryEnabled: boolean;
  globalLaunchEnabled: boolean;
  globalLaunchShortcut: string;
}
export type SettingKey = keyof Settings;
export type SettingSource = 'default' | 'user' | 'workspace' | 'session';
export type SettingGroup = 'appearance' | 'editor' | 'privacy';
export interface SettingDefinition {
  key: SettingKey; label: string; keywords: string; group: SettingGroup;
  kind: 'theme' | 'font' | 'number' | 'tab' | 'whitespace' | 'boolean' | 'shortcut';
  description?: string;
}
export interface SettingsDiagnostic { key: string; source: SettingSource; message: string }

export const defaultSettings: Readonly<Settings> = Object.freeze({
  theme: 'system', fontFamily: 'Cascadia Mono', fontSize: 14, lineHeight: 1.85,
  tabSize: 4, insertSpaces: true, wordWrap: true, lineNumbers: true, highlightActiveLine: true,
  whitespaceMode: 'none', folding: true, markdownAllowHtml: false,
  recentHistoryEnabled: true, autoSave: false, globalLaunchEnabled: false, globalLaunchShortcut: 'Ctrl+Shift+Space',
});
export const settingDefinitions: readonly SettingDefinition[] = [
  { key: 'markdownAllowHtml', label: '允许受限 Markdown HTML', keywords: 'markdown html preview 清洗 安全 阅读', group: 'editor', kind: 'boolean',
    description: '默认关闭。启用后仅显示清洗后的结构标签；脚本、事件、表单、任意样式和自动远程资源始终禁用。' },
  { key: 'theme', label: '主题', keywords: 'theme light dark system 亮 暗 跟随系统', group: 'appearance', kind: 'theme' },
  { key: 'fontFamily', label: '编辑器字体', keywords: 'font family 本机 等宽 Cascadia Consolas', group: 'appearance', kind: 'font' },
  { key: 'fontSize', label: '编辑字号', keywords: 'font size 字体 大小', group: 'appearance', kind: 'number' },
  { key: 'lineHeight', label: '编辑行高', keywords: 'line height 间距', group: 'appearance', kind: 'number' },
  { key: 'tabSize', label: 'Tab 宽度', keywords: 'indent 缩进 tab 2 4 8', group: 'editor', kind: 'tab' },
  { key: 'insertSpaces', label: '缩进使用空格', keywords: 'indent insert spaces 空格 制表符', group: 'editor', kind: 'boolean' },
  { key: 'wordWrap', label: '自动换行', keywords: 'word wrap 长行 折行', group: 'editor', kind: 'boolean' },
  { key: 'lineNumbers', label: '显示行号', keywords: 'line numbers 行号', group: 'editor', kind: 'boolean' },
  { key: 'highlightActiveLine', label: '突出当前行', keywords: 'highlight active line 高亮 光标 当前行', group: 'editor', kind: 'boolean' },
  { key: 'whitespaceMode', label: '空白字符显示', keywords: 'whitespace spaces tabs 空白 空格 制表符', group: 'editor', kind: 'whitespace' },
  { key: 'folding', label: '代码折叠', keywords: 'fold folding gutter 折叠 代码块', group: 'editor', kind: 'boolean',
    description: '纯文本模式没有可折叠语法，不显示折叠栏。' },
  { key: 'autoSave', label: '自动保存已命名文件', keywords: 'auto save 自动 保存 空闲', group: 'editor', kind: 'boolean',
    description: '默认关闭。空闲1500ms后保存；冲突或失败时暂停。无标题仅写恢复快照，设置预览期间不自动保存。' },
  { key: 'recentHistoryEnabled', label: '记录最近打开', keywords: 'privacy recent history 最近 文件 工作区 隐私', group: 'privacy', kind: 'boolean' },
  { key: 'globalLaunchEnabled', label: '启用系统全局唤起', keywords: 'privacy shortcut global activation show focus 全局 快捷键 唤起 窗口', group: 'privacy', kind: 'boolean',
    description: '默认关闭。仅用于显示并聚焦轻羽窗口，不把普通应用快捷键注册为全局键；保存后生效。' },
  { key: 'globalLaunchShortcut', label: '全局唤起快捷键', keywords: 'privacy shortcut global activation show focus 全局 快捷键 唤起 窗口', group: 'privacy', kind: 'shortcut',
    description: '例如 Ctrl+Shift+Space。注册失败或与其他应用冲突时会在应用内显示原因。' },
];
export const workspaceSettingKeys = new Set<SettingKey>(['tabSize', 'insertSpaces', 'wordWrap', 'lineNumbers',
  'highlightActiveLine', 'whitespaceMode', 'folding']);
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(defaultSettings, key);

export function isSettingValue<K extends SettingKey>(key: K, value: unknown): value is Settings[K] {
  switch (key) {
    case 'theme': return value === 'light' || value === 'dark' || value === 'system';
    case 'fontFamily': return typeof value === 'string' && value.length > 0 && value.length <= 128
      && value.trim() === value && !/["\\;{}<>]/.test(value)
      && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    case 'fontSize': return typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 40;
    case 'lineHeight': return typeof value === 'number' && Number.isFinite(value) && value >= 1.2 && value <= 2.5;
    case 'tabSize': return value === 2 || value === 4 || value === 8;
    case 'whitespaceMode': return value === 'none' || value === 'current' || value === 'all';
    case 'globalLaunchShortcut': return typeof value === 'string' && normalizeShortcut(value) === value
      && shortcutRestriction(value) === null;
    default: return typeof value === 'boolean';
  }
}

export function mergeSettings(user: RawSettings = {}, workspace: RawSettings = {}, session: RawSettings = {}) {
  const settings: Settings = { ...defaultSettings };
  const sources = Object.fromEntries(settingDefinitions.map(definition => [definition.key, 'default'])) as Record<SettingKey, SettingSource>;
  const diagnostics: SettingsDiagnostic[] = [];
  function apply<K extends SettingKey>(key: K, value: JsonValue, source: SettingSource) {
    if (!isSettingValue(key, value)) { diagnostics.push({ key, source, message: '值无效，保留原配置并使用上层有效值。' }); return; }
    settings[key] = value; sources[key] = source;
  }
  for (const [source, values] of [['user', user], ['workspace', workspace], ['session', session]] as const) {
    for (const [key, value] of Object.entries(values)) {
      if (key === recentHistoryItemsSetting || key === languagePreferencesSetting || key === favoritesSetting) continue;
      if (!isSettingKey(key)) {
        diagnostics.push({ key, source, message: '未识别的设置已保留，当前版本不应用此项。' }); continue;
      }
      if (source === 'workspace' && !workspaceSettingKeys.has(key)) {
        diagnostics.push({ key, source, message: '工作区不允许覆盖此设置，已使用上层有效值。' }); continue;
      }
      apply(key, value, source);
    }
  }
  return { settings, sources, diagnostics };
}

export function parseSettingsImport(text: string): ResultEnvelope<RawSettings> {
  if (new TextEncoder().encode(text).byteLength > 65_536) {
    return { ok: false, error: { code: 'TOO_LARGE', message: '设置文件超过64KiB限制。', retryable: false } };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Reflect.get(value, 'schemaVersion') !== 1
      || !isRawSettings(Reflect.get(value, 'settings'))) throw new Error('Invalid settings document');
    return { ok: true, value: structuredClone(Reflect.get(value, 'settings') as RawSettings) };
  } catch {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '设置必须是schemaVersion为1、含settings对象的有效JSON；原配置未改变。', retryable: false } };
  }
}

export function exportSettings(settings: RawSettings): string {
  return `${JSON.stringify({ schemaVersion: 1, settings }, null, 2)}\n`;
}

export function settingsChanges(before: RawSettings, after: RawSettings) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => ({ key, before: before[key], after: after[key], known: isSettingKey(key) }));
}

export function resetSettings(settings: RawSettings, keys: readonly SettingKey[]): RawSettings {
  const next = structuredClone(settings);
  for (const key of keys) delete next[key];
  return next;
}

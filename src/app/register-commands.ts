import { CommandRegistry, type CommandDefinition } from '../shared/commands/registry';

export const appCommandIds = ['file.new', 'file.open', 'workspace.open', 'file.save', 'file.saveAs', 'file.saveCopy',
  'file.saveAll', 'file.close', 'editor.find', 'tabs.pin', 'view.sidebar', 'view.theme', 'settings.open', 'commands.open', 'files.quickOpen'] as const;
export type AppCommandId = typeof appCommandIds[number];
export interface AppCommandState {
  hasDocument: boolean;
  readOnlyReason: string | null;
  canSaveAs: boolean;
  hasDirty: boolean;
  isPreview: boolean;
  opening: boolean;
  saving: boolean;
  closing: boolean;
  batchBusy: boolean;
}
export type AppCommandActions = Record<AppCommandId, () => void | Promise<void>>;

const hasDocument = (state: AppCommandState) => state.hasDocument ? null : '请先打开或新建文档。';
const saveBusy = (state: AppCommandState) => state.closing ? '正在关闭文档。' : state.saving || state.batchBusy ? '请等待当前保存结束。' : null;
type CommandInfo = [AppCommandId, string, string, string | null, (state: AppCommandState) => string | null];
const commandInfo: CommandInfo[] = [
  ['file.new', '新建文本', 'new untitled document 草稿', 'Ctrl+N', () => null],
  ['file.open', '打开文件', 'open file', 'Ctrl+O', state => state.opening ? '正在打开，请等待。' : null],
  ['workspace.open', '打开文件夹', 'folder workspace 工作区', 'Ctrl+Shift+E', state => state.opening ? '正在打开，请等待。' : null],
  ['file.save', '保存', 'save write', 'Ctrl+S', state => hasDocument(state) ?? saveBusy(state) ?? state.readOnlyReason],
  ['file.saveAs', '另存为', 'save as', 'Ctrl+Shift+S', state => hasDocument(state) ?? saveBusy(state) ?? (state.canSaveAs ? null : '此文档不能另存为。')],
  ['file.saveCopy', '保存副本', 'save copy', null, state => hasDocument(state) ?? saveBusy(state) ?? (state.canSaveAs ? null : '此文档不能保存副本。')],
  ['file.saveAll', '全部保存', 'save all', null, state => saveBusy(state) ?? (state.hasDirty ? null : '没有未保存修改。')],
  ['file.close', '关闭当前标签', 'close tab', 'Ctrl+W', state => hasDocument(state) ?? (state.batchBusy || state.closing ? '请等待当前操作结束。' : null)],
  ['editor.find', '文件内查找与替换', 'find search replace 搜索', 'Ctrl+F', state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['tabs.pin', '固定标签', 'pin preview 预览', null, state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : state.isPreview ? null : '当前标签已固定。')],
  ['view.sidebar', '切换资源管理器', 'sidebar explorer 侧栏', 'Ctrl+B', () => null],
  ['view.theme', '切换亮暗主题', 'theme dark light', null, () => null],
  ['settings.open', '打开设置', 'settings preferences theme font 设置 主题 字体', null, state => state.closing ? '请等待当前关闭操作。' : null],
  ['commands.open', '打开命令面板', 'command palette 命令', 'Ctrl+Shift+P', () => null],
  ['files.quickOpen', '快速打开文件', 'quick open 文件导航', 'Ctrl+P', () => null],
];

export function createAppCommands() {
  const definitions: CommandDefinition<AppCommandState, AppCommandActions>[] = commandInfo.map(([id, title, keywords, defaultBinding, disabledReason]) => ({
    id, title, keywords, defaultBinding, disabledReason,
    execute: (_state, actions) => actions[id](),
  }));
  return new CommandRegistry(definitions);
}

import { CommandRegistry, type CommandDefinition } from '../shared/commands/registry';

export const appCommandIds = ['file.new', 'file.open', 'workspace.open', 'file.save', 'file.saveAs', 'file.saveCopy',
  'file.saveAll', 'file.close', 'editor.find', 'editor.toggleComment', 'editor.toggleBlockComment',
  'search.workspace', 'tools.format',
  'editor.moveLineUp', 'editor.moveLineDown', 'editor.copyLineUp', 'editor.copyLineDown', 'editor.insertBlankLine',
  'editor.complete', 'editor.selectNextOccurrence', 'editor.selectAllOccurrences', 'editor.toggleFold',
  'navigation.goToLine', 'navigation.back', 'navigation.forward', 'navigation.outline',
  'editor.fontIncrease', 'editor.fontDecrease', 'editor.fontReset',
  'tabs.pin', 'tabs.split', 'tabs.closeSplit', 'tabs.reopen', 'tabs.closeOthers', 'tabs.closeRight', 'tabs.closeClean',
  'view.sidebar', 'view.theme', 'settings.open', 'commands.open', 'files.quickOpen'] as const;
export type AppCommandId = typeof appCommandIds[number];
export interface AppCommandState {
  formatReason?: string | null;
  hasDocument: boolean;
  readOnlyReason: string | null;
  canSaveAs: boolean;
  hasDirty: boolean;
  isPreview: boolean;
  tabCount: number;
  cleanTabCount: number;
  isSplit: boolean;
  canReopen: boolean;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  hasWorkspace: boolean;
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
  ['search.workspace', '在文件和工作区中查找', 'workspace search find in files 目录搜索', 'Ctrl+Shift+F', state => state.hasWorkspace ? null : '请先打开至少一个文件夹。'],
  ['tools.format', '格式化文档', 'format json xml html css javascript typescript yaml sql 格式', 'Shift+Alt+F', state => hasDocument(state) ?? state.readOnlyReason ?? state.formatReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.toggleComment', '切换行注释', 'comment line annotation 注释', 'Ctrl+/', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.toggleBlockComment', '切换块注释', 'block comment annotation 注释', 'Shift+Alt+A', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.moveLineUp', '上移当前行', 'move line up 行', 'Alt+ArrowUp', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.moveLineDown', '下移当前行', 'move line down 行', 'Alt+ArrowDown', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.copyLineUp', '向上复制当前行', 'copy line up duplicate 行', 'Shift+Alt+ArrowUp', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.copyLineDown', '向下复制当前行', 'copy line down duplicate 行', 'Shift+Alt+ArrowDown', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.insertBlankLine', '插入空行', 'blank line new line 空行', 'Ctrl+Enter', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.complete', '触发单词补全', 'completion autocomplete word 补全', 'Ctrl+Space', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.selectNextOccurrence', '选择下一个相同词', 'select occurrence multi cursor 多光标 同词', 'Ctrl+D', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.selectAllOccurrences', '选择全部相同词', 'select all occurrences 多光标 同词', 'Ctrl+Shift+L', state => hasDocument(state) ?? state.readOnlyReason ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.toggleFold', '切换代码折叠', 'fold unfold collapse 折叠', null, state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['navigation.goToLine', '跳转到行列', 'goto line column 行 列', 'Ctrl+G', state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['navigation.back', '导航后退', 'navigation back previous location 后退', 'Alt+ArrowLeft', state => state.canNavigateBack ? null : '没有可后退的导航位置。'],
  ['navigation.forward', '导航前进', 'navigation forward next location 前进', 'Alt+ArrowRight', state => state.canNavigateForward ? null : '没有可前进的导航位置。'],
  ['navigation.outline', '打开当前文档大纲', 'outline symbols 大纲', null, state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.fontIncrease', '放大编辑字号', 'font zoom in 字体 放大', 'Ctrl+=', state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.fontDecrease', '缩小编辑字号', 'font zoom out 字体 缩小', 'Ctrl+-', state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['editor.fontReset', '恢复默认编辑字号', 'font zoom reset 14px 默认 字体', 'Ctrl+0', state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : null)],
  ['tabs.pin', '固定标签', 'pin preview 预览', null, state => hasDocument(state) ?? (state.closing ? '正在关闭文档。' : state.isPreview ? null : '当前标签已固定。')],
  ['tabs.split', '向右拆分编辑器', 'split group dual view 双栏 分屏', null, state => hasDocument(state) ?? (state.isSplit ? '已经拆分为两个编辑组。' : state.closing ? '正在关闭文档。' : null)],
  ['tabs.closeSplit', '关闭拆分', 'close split dual view 双栏 分屏', null, state => state.isSplit ? null : '当前没有拆分编辑组。'],
  ['tabs.reopen', '重新打开关闭的标签', 'reopen closed tab 恢复', 'Ctrl+Shift+T', state => state.canReopen ? null : '没有可重新打开的标签。'],
  ['tabs.closeOthers', '关闭其他标签', 'close other tabs 批量关闭', null, state => state.tabCount > 1 ? null : '没有其他打开的标签。'],
  ['tabs.closeRight', '关闭右侧标签', 'close tabs to right 批量关闭', null, state => state.tabCount > 1 ? null : '当前标签右侧没有标签。'],
  ['tabs.closeClean', '关闭已保存标签', 'close saved clean tabs 批量关闭', null, state => state.cleanTabCount > 0 ? null : '没有可关闭的已保存标签。'],
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

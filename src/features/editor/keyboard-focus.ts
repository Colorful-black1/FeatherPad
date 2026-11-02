import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap, showPanel, ViewPlugin, type Panel, type ViewUpdate } from '@codemirror/view';

export const setTabFocusMode = StateEffect.define<boolean>();
export const tabFocusMode = StateField.define<boolean>({
  create: () => false,
  update: (enabled, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setTabFocusMode)) enabled = effect.value;
    return enabled;
  },
});

const movingFocus = (state: EditorState) => state.facet(EditorState.readOnly) || state.field(tabFocusMode);
const keyboardHelp = (state: EditorState) => state.facet(EditorState.readOnly)
  ? '只读文档，Tab 和 Shift+Tab 移动焦点。'
  : movingFocus(state) ? 'Tab 和 Shift+Tab 移动焦点；Ctrl+M 恢复缩进。'
    : 'Tab 缩进，Shift+Tab 反缩进；Ctrl+M 切换焦点模式，也可先按 Esc 再按 Tab 离开编辑器。';

function toggleFocus(view: EditorView) {
  if (view.state.facet(EditorState.readOnly)) return true;
  const enabled = !view.state.field(tabFocusMode);
  view.dispatch({ effects: [setTabFocusMode.of(enabled), EditorView.announce.of(enabled
    ? 'Tab 移动焦点已开启。' : 'Tab 缩进已恢复；先按 Esc 再按 Tab 可离开编辑器。')] });
  return true;
}

function focusPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'editor-keyboard-panel';
  dom.setAttribute('role', 'group');
  dom.setAttribute('aria-label', '编辑器键盘操作');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Tab 移动焦点');
  button.setAttribute('aria-keyshortcuts', 'Control+M');
  const hint = document.createElement('span');
  dom.append(button, hint);
  const update = () => {
    const readOnly = view.state.facet(EditorState.readOnly);
    const enabled = movingFocus(view.state);
    if (button.getAttribute('aria-pressed') === String(enabled) && button.disabled === readOnly) return;
    button.textContent = enabled ? 'Tab：移动焦点' : 'Tab：缩进';
    button.setAttribute('aria-pressed', String(enabled));
    button.disabled = readOnly;
    button.title = keyboardHelp(view.state);
    hint.textContent = readOnly ? '只读文档' : enabled ? 'Ctrl+M 恢复缩进' : 'Ctrl+M 切换 · Esc 后 Tab 离开';
  };
  button.onclick = () => { toggleFocus(view); view.focus(); };
  update();
  return { dom, update };
}

export const editorKeyboardFocus: Extension = [
  tabFocusMode,
  Prec.highest(keymap.of([
    { key: 'Ctrl-m', run: toggleFocus, preventDefault: true },
    // Keep the escape route even when Escape also collapses a text selection.
    { key: 'Escape', run: view => { view.setTabFocusMode(2000); return false; } },
  ])),
  ViewPlugin.fromClass(class {
    private destroyed = false;
    constructor(readonly view: EditorView) {
      // CodeMirror constructs plugins before its input handlers are ready.
      queueMicrotask(() => { if (!this.destroyed) view.setTabFocusMode(movingFocus(view.state)); });
    }
    update(update: ViewUpdate) {
      if (update.startState.field(tabFocusMode) !== update.state.field(tabFocusMode)
        || update.startState.facet(EditorState.readOnly) !== update.state.facet(EditorState.readOnly)) {
        this.view.setTabFocusMode(movingFocus(update.state));
      }
    }
    destroy() { this.destroyed = true; }
  }),
  EditorView.contentAttributes.of(view => ({ 'aria-description': keyboardHelp(view.state) })),
  showPanel.of(focusPanel),
];

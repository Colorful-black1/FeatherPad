import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

const editability = new Compartment();
function accessExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({
    'aria-label': readOnly ? '文档内容（只读）' : '文档内容', 'aria-readonly': String(readOnly), tabindex: '0',
  })];
}

export function reconfigureReadOnly(state: EditorState, readOnly: boolean): EditorState {
  return state.facet(EditorState.readOnly) === readOnly ? state : state.update({ effects: editability.reconfigure(accessExtensions(readOnly)) }).state;
}

export function createEditorState(text: string, readOnly: boolean) {
  return EditorState.create({
    doc: text,
    extensions: [
      history(), keymap.of([...defaultKeymap, ...historyKeymap]), lineNumbers(),
      EditorState.tabSize.of(4), EditorView.lineWrapping,
      editability.of(accessExtensions(readOnly)),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--bg-editor)', color: 'var(--text-primary)' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--editor-size)', overflow: 'auto' },
        '.cm-gutters': { backgroundColor: 'var(--bg-editor)', color: 'var(--text-muted)', borderRight: 'none' },
        '.cm-content': { padding: '16px 0', lineHeight: '1.85' },
        '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
      }),
    ],
  });
}

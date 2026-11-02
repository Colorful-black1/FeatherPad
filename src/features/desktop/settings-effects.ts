import type { DocumentRegistry } from '../editor/documents';
import type { SettingsCoordinator } from './settings';

export function applySettingsToEditors(coordinator: SettingsCoordinator, registry: DocumentRegistry): () => void {
  let applying = false;
  const sync = () => {
    if (applying) return;
    applying = true;
    try {
      const settings = coordinator.getSnapshot().settings;
      registry.applyEditorPreferences({ indentWidth: settings.tabSize, insertSpaces: settings.insertSpaces,
        wordWrap: settings.wordWrap, lineNumbers: settings.lineNumbers, highlightActiveLine: settings.highlightActiveLine });
    } finally { applying = false; }
  };
  const unsubscribeSettings = coordinator.subscribe(sync);
  const unsubscribeDocuments = registry.subscribe(sync);
  sync();
  return () => { unsubscribeSettings(); unsubscribeDocuments(); };
}

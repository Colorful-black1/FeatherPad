import { test as base, expect } from '@playwright/test';

export { expect };
export type { Page, Locator } from '@playwright/test';

// Legacy file/UI scenarios mock only their own business commands. Supply an empty,
// explicit desktop lifecycle so those scenarios remain independent of recovery tests.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      // Business mocks belong to the host, never the sandboxed document frames.
      if (window.top !== window) return;
      let native: Record<string, unknown> | undefined;
      let callbackId = 0;
      Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        get: () => native,
        set: (business: Record<string, unknown>) => {
          const invoke = business.invoke;
          if (typeof invoke !== 'function') throw new Error('A business IPC mock is required');
          native = {
            ...business,
            metadata: { currentWindow: { label: 'main' } },
            transformCallback: () => ++callbackId,
            invoke: async (command: string, args: Record<string, unknown> = {}) => {
              switch (command) {
                case 'plugin:event|listen': return ++callbackId;
                case 'plugin:event|unlisten': return null;
                case 'set_global_shortcut': return { ok: true, value: { enabled: false } };
                case 'load_session': return { ok: true, value: { session: null, warning: null, restoredGrantIds: [] } };
                case 'list_recovery_entries': return { ok: true, value: {
                  entries: [], failures: [], startupWarnings: [], storageBytes: 0, saveTransactions: [],
                } };
                case 'get_desktop_integration': return { ok: true, value: {
                  runtimeMode: 'installed', dataRoot: 'E:\\fixtures\\app-data',
                  executablePath: 'E:\\fixtures\\featherpad.exe',
                  fileAssociation: false, contextMenu: false, supportedExtensions: ['.txt'],
                  changesDefaultApp: false,
                } };
                case 'take_desktop_requests': return { ok: true, value: [] };
                case 'save_session': {
                  const manifest = args.manifest;
                  if (!manifest || typeof manifest !== 'object') throw new Error('Session manifest is required');
                  return { ok: true, value: { saved: true, persistedAt: Reflect.get(manifest, 'persistedAt') } };
                }
                case 'clear_session': return { ok: true, value: { cleared: true } };
                case 'write_recovery_snapshot': return { ok: true, value: {
                  documentId: args.documentId, durableVersion: args.documentVersion,
                  receiptId: crypto.randomUUID(), writtenAt: new Date().toISOString(),
                } };
                default: return invoke(command, args);
              }
            },
          };
        },
      });
    });
    await use(page);
  },
});

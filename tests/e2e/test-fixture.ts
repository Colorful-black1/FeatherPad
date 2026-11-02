import { test as base, expect } from '@playwright/test';

export { expect };
export type { Page, Locator } from '@playwright/test';

// Legacy file/UI scenarios mock only their own business commands. Supply an empty,
// explicit desktop lifecycle so those scenarios remain independent of recovery tests.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
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
                case 'load_session': return { ok: true, value: { session: null, warning: null, restoredGrantIds: [] } };
                case 'list_recovery_entries': return { ok: true, value: {
                  entries: [], failures: [], startupWarnings: [], storageBytes: 0, saveTransactions: [],
                } };
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

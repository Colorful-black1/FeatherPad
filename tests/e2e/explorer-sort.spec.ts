import { menuItem } from '../ui-actions';
import { expect, test } from './test-fixture';

test('Web mock: file tree sorts by name, modification and creation time', async ({ page }) => {
  await page.addInitScript(() => {
    const grant = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    let version = 1;
    const entry = (name: string, kind: 'file' | 'directory', modifiedAt: string, createdAt: string) => ({
      id: `${kind}-${name}`, name, kind, ref: { ...grant, relativePath: name },
      isHidden: false, isReadOnly: false, revision: 'a'.repeat(64), modifiedAt, createdAt,
    });
    const items = [
      entry('delta.txt', 'file', '2026-04-01T00:00:00Z', '2026-01-02T00:00:00Z'),
      entry('alpha.txt', 'file', '2026-02-01T00:00:00Z', '2026-01-04T00:00:00Z'),
      entry('charlie.txt', 'file', '2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      entry('folder', 'directory', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
    ];
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version, revision: 'a'.repeat(64), settings: {}, warning: null });
        case 'save_settings': version += 1; return ok({ version, revision: 'b'.repeat(64) });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant, displayName: 'sorted-project' });
        case 'inspect_workspace_root': return ok({ ref: grant, displayName: 'sorted-project',
          displayPath: 'E:/sorted-project', canonicalIdentity: 'b'.repeat(64) });
        case 'list_directory': return ok({ items, nextCursor: null });
        case 'start_watch': return ok({ watchId: 'sort-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected command ${command} ${JSON.stringify(args)}`);
      }
    } });
  });
  await page.goto('/');
  await (await menuItem(page, '打开文件夹')).click();
  const rows = page.locator('[data-workspace-tree] [role="treeitem"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('folder');
  await expect(rows.nth(1)).toContainText('alpha.txt');
  await expect(rows.nth(2)).toContainText('charlie.txt');
  await expect(rows.nth(3)).toContainText('delta.txt');

  const sortButton = page.getByRole('button', { name: '文件排序', exact: true });
  await sortButton.click();
  const sortMenu = page.getByRole('menu', { name: '文件排序', exact: true });
  await expect(sortMenu.getByRole('menuitemradio')).toHaveCount(6);
  await expect(sortMenu.getByRole('menuitemradio', { name: '名称 A → Z', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  await sortMenu.getByRole('menuitemradio', { name: '修改时间 新 → 旧', exact: true }).click();
  await expect(rows.nth(0)).toContainText('folder');
  await expect(rows.nth(1)).toContainText('delta.txt');
  await expect(rows.nth(2)).toContainText('charlie.txt');
  await expect(rows.nth(3)).toContainText('alpha.txt');
  await expect(sortButton).toBeFocused();

  await sortButton.click();
  await page.getByRole('menuitemradio', { name: '创建时间 旧 → 新', exact: true }).click();
  await expect(rows.nth(0)).toContainText('folder');
  await expect(rows.nth(1)).toContainText('charlie.txt');
  await expect(rows.nth(2)).toContainText('delta.txt');
  await expect(rows.nth(3)).toContainText('alpha.txt');

  await sortButton.click();
  await page.getByRole('menuitemradio', { name: '名称 Z → A', exact: true }).click();
  await expect(rows.nth(0)).toContainText('folder');
  await expect(rows.nth(1)).toContainText('delta.txt');
  await expect(rows.nth(2)).toContainText('charlie.txt');
  await expect(rows.nth(3)).toContainText('alpha.txt');
});

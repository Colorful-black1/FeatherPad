import { expect, test } from './test-fixture';

test('F6 cycles visible regions in both directions and preserves editor selection and undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const header = page.getByRole('button', { name: /^快速打开/ });
  const toggle = page.getByRole('button', { name: '切换资源管理器', exact: true });
  const all = page.locator('.recent-panel').getByRole('button', { name: '全部', exact: true });
  const create = page.getByRole('button', { name: '新建文本', exact: true });
  const status = page.getByRole('status', { name: '应用状态', exact: true });
  await expect(header).toBeVisible();
  await page.keyboard.press('F6');
  await expect(header).toBeFocused();
  for (const target of [toggle, all, create, status, header]) {
    await page.keyboard.press('F6');
    await expect(target).toBeFocused();
  }
  await page.keyboard.press('Shift+F6');
  await expect(status).toBeFocused();
  await expect(status).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Shift+F6');
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('区域导航正文😀');
  await page.keyboard.press('Control+a');
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  const tab = page.getByRole('tab', { name: /无标题 1/ });
  for (const target of [status, header, toggle, all, create, tab, editor]) {
    await page.keyboard.press('F6');
    await expect(target).toBeFocused();
  }
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await expect(tab).not.toContainText('●');
  await page.keyboard.press('Control+n');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(page.getByRole('tab', { name: '无标题 2', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('region memory returns to a prior control, skips a closed sidebar and stays inside modal dialogs', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+n');
  const filter = page.locator('.recent-panel').getByRole('button', { name: '文件', exact: true });
  const toggle = page.getByRole('button', { name: '切换资源管理器', exact: true });
  const create = page.getByRole('button', { name: '新建文本', exact: true });
  await filter.focus();
  await page.keyboard.press('F6');
  await expect(create).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(filter).toBeFocused();
  await page.keyboard.press('Control+b');
  await expect(page.getByRole('complementary', { name: '资源管理器' })).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press('F6');
  await expect(create).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '资源管理器' })).toBeVisible();
  const settings = page.getByRole('button', { name: '打开设置', exact: true });
  await settings.click();
  const search = page.getByRole('dialog', { name: '设置', exact: true }).getByRole('searchbox', { name: '搜索设置', exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.press('F6');
  await expect(search).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
});

test('narrow sidebar focuses on open, closes on Escape or entry into the document and returns visible focus', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: '切换资源管理器', exact: true });
  const sidebar = page.getByRole('complementary', { name: '资源管理器' });
  const all = page.locator('.recent-panel').getByRole('button', { name: '全部', exact: true });
  const create = page.getByRole('button', { name: '新建文本', exact: true });
  await toggle.click();
  await expect(all).toBeFocused();
  await page.keyboard.press('F6');
  await expect(sidebar).toHaveCount(0);
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('窄屏正文');
  await page.keyboard.press('Control+b');
  await expect(all).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(all).toBeFocused();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.getByRole('searchbox', { name: '搜索设置', exact: true })).toBeFocused();
  await expect(sidebar).toBeVisible();
  await page.keyboard.press('F6');
  await expect(dialog.getByRole('searchbox', { name: '搜索设置', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeVisible();
  await page.keyboard.press('F6');
  await expect(all).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(editor).toHaveText('窄屏正文');
  await page.screenshot({ path: test.info().outputPath('narrow-region-focus.png') });
});

test('Web mock: selecting an already open tree file closes the narrow overlay without duplicating its buffer', async ({ page }) => {
  await page.addInitScript(() => {
    const root = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const metadata = { displayPath: 'focus-root\\one.txt', sizeBytes: 4, isReadOnly: false,
      modifiedAt: '2026-11-02T00:00:00Z', diskRevision: 'a'.repeat(64) };
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null,
          settings: { recentHistoryEnabled: false }, warning: null, recoveryCopies: [] });
        case 'list_font_families': return ok({ families: ['Cascadia Mono'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant: root, displayName: 'focus-root' });
        case 'inspect_workspace_root': return ok({ ref: root, displayName: 'focus-root', displayPath: 'E:/focus-root', canonicalIdentity: 'c'.repeat(64) });
        case 'list_directory': return ok({ items: [{ id: 'one.txt', ref: { ...root, relativePath: 'one.txt' },
          name: 'one.txt', kind: 'file', isHidden: false, isReadOnly: false, revision: 'a'.repeat(64) }], nextCursor: null });
        case 'open_document': return ok({ documentId: '22222222-2222-4222-8222-222222222222',
          ref: { ...root, relativePath: 'one.txt' }, metadata, canonicalIdentity: 'a'.repeat(64),
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: 'body', newlineMap: { documentVersion: 0, endings: [] } } });
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'focus-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  const file = page.getByRole('treeitem', { name: 'one.txt', exact: true });
  await expect(file).toBeVisible();
  await file.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  const sidebar = page.getByRole('complementary', { name: '资源管理器' });
  await expect(sidebar).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' retained');
  await page.keyboard.press('Control+b');
  await file.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('body retained');
  await expect(page.getByRole('tab')).toHaveCount(1);
});

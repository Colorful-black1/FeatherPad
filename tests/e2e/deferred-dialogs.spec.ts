import { expect, test } from './test-fixture';

test('Escape closes a delayed dialog and a late module cannot reopen it or change the buffer', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/SettingsDialog-[^/]+\.js$/, async route => { await gate; await route.continue(); });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '新建文本', exact: true }).click();
    await page.locator('.cm-content').focus(); await page.keyboard.insertText('kept while loading');
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '加载对话框', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const fetched = page.waitForResponse(/\/assets\/SettingsDialog-[^/]+\.js$/);
    release(); await fetched;
    await page.evaluate(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toHaveText('kept while loading');
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cm-content')).toHaveText('kept while loading');
  } finally { release(); }
});

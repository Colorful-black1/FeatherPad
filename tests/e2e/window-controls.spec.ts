import { expect, test } from './test-fixture';

test('custom titlebar keeps one brand and exposes working window controls at the minimum width', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 1, revision: 'a'.repeat(64),
          settings: { theme: 'dark' }, warning: null });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        default: throw new Error(`Unexpected command ${command}`);
      }
    } });
  });
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/');
  const brand = page.locator('.app-brand');
  await expect(brand).toContainText('轻羽');
  await expect(brand).toContainText('FeatherPad');
  await expect(page.locator('.app-heading')).toHaveCount(1);
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('button', { name: '最大化窗口', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'windowControlCalls'))).toEqual(
    ['toggle-maximize', 'minimize', 'toggle-maximize', 'close']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.app-heading').evaluate(element => element.getBoundingClientRect().height))
    .toBeLessThan(50);
});

import { expect, test } from './test-fixture';

test('brand, theme and keyboard-accessible sidebar in the Web shell', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page).toHaveTitle('轻羽 FeatherPad');
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  const sidebar = page.getByRole('button', { name: '切换资源管理器' });
  await expect(sidebar).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: test.info().outputPath('shell-light.png') });
  await sidebar.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '资源管理器' })).toHaveCount(0);
  await expect(sidebar).toBeFocused();
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('shell-dark.png') });
  expect(errors).toEqual([]);
});

test('narrow overlay and 200 percent CSS zoom retain the document area', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '切换资源管理器' });
  await expect(sidebar).toHaveAttribute('aria-expanded', 'false');
  await sidebar.click();
  await expect(page.getByRole('complementary', { name: '资源管理器' })).toBeVisible();
  await page.getByRole('button', { name: '关闭资源管理器' }).click({ position: { x: 600, y: 200 } });
  await expect(sidebar).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(page.getByRole('main', { name: '文档' })).toBeInViewport();
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('shell-zoom200.png') });
});

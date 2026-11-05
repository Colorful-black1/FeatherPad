import { expect, test } from './test-fixture';

test('basic find keeps replacement and matching options out of the initial form', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.insertText('apple apple');
  await page.keyboard.press('Control+f');
  const find = page.getByRole('region', { name: '文件内查找替换' });
  await expect(find.getByRole('textbox', { name: '替换内容' })).not.toBeVisible();
  await expect(find.getByRole('checkbox', { name: '区分大小写' })).not.toBeVisible();
  await find.getByRole('textbox', { name: '查找内容' }).fill('apple');
  await expect(find.locator('.find-result')).toContainText('2 处');
  await find.getByRole('button', { name: '下一个匹配' }).click();
  await expect(find.locator('.find-result')).toContainText('2/2');
  await find.getByText('替换', { exact: true }).click();
  await expect(find.getByRole('textbox', { name: '替换内容' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('find-disclosure.png') });
});

test('empty directory search explains the requirement and offers an in-place folder picker', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+f');
  const panel = page.getByRole('region', { name: '在文件和文件夹中查找' });
  await expect(panel).toContainText('先打开文件夹才能搜索');
  await expect(panel.getByRole('button', { name: '打开文件夹…', exact: true })).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByLabel('替换为', { exact: true })).not.toBeVisible();
  await expect(panel.getByLabel('包含 glob')).not.toBeVisible();
  await page.screenshot({ path: test.info().outputPath('search-empty.png') });
  await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
  await expect(panel.getByRole('button', { name: '打开文件夹…', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('search-empty-150.png') });
});

test('invalid directory rules explicitly keep the applied rules and can be restored', async ({ page }) => {
  await page.addInitScript(() => {
    const grant = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 1, revision: 'a'.repeat(64), settings: {}, warning: null, recoveryCopies: [] });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'choose_folder': return ok({ grant, displayName: 'fixture-folder' });
        case 'inspect_workspace_root': return ok({ ref: grant, displayName: 'fixture-folder', displayPath: 'E:/fixture-folder', canonicalIdentity: 'a'.repeat(64) });
        case 'list_directory': return ok({ items: [], nextCursor: null });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'start_watch': return ok({ watchId: 'fixture-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+f');
  const search = page.getByRole('region', { name: '在文件和文件夹中查找' });
  await search.getByRole('button', { name: '打开文件夹…', exact: true }).click();
  await expect(search.locator('.search-scope-summary')).toContainText('fixture-folder');
  await search.getByLabel('搜索内容', { exact: true }).fill('example');
  await expect(search.getByRole('button', { name: '开始搜索', exact: true })).toBeEnabled();
  const rules = page.locator('.workspace-filter-rules');
  await rules.locator('summary').click();
  const include = rules.getByRole('textbox', { name: '包含 glob' });
  await include.fill('x'.repeat(1025));
  await include.press('Tab');
  await expect(include).toHaveAttribute('aria-invalid', 'true');
  await expect(rules.getByRole('alert')).toContainText('未应用，仍使用原规则');
  await rules.getByRole('button', { name: '还原已应用规则', exact: true }).click();
  await expect(include).toHaveValue('');
  await expect(include).toHaveAttribute('aria-invalid', 'false');
  await include.fill('*.md');
  await include.press('Tab');
  await expect(rules).toContainText('已应用');
  await expect(include).toHaveValue('*.md');
});

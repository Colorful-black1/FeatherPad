import { test, expect } from './test-fixture';
import { sidebarSection } from '../ui-actions';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let profile = { schemaVersion: 1, version: 1, revision: 'a'.repeat(64), settings: { theme: 'system', future: { retain: true } } as Record<string, unknown>, warning: null, recoveryCopies: [] };
    let failSave = false;
    const ref = { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' };
    const metadata = { displayPath: 'E:\\fixtures\\settings-test.txt', sizeBytes: 4,
      modifiedAt: '2026-11-02T00:00:00Z', diskRevision: 'd'.repeat(64), isReadOnly: false };
    Reflect.set(window, 'settingsFixture', { get: () => profile, fail: () => { failSave = true; } });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok(profile);
        case 'save_settings': {
          if (failSave) return { ok: false, error: { code: 'DISK_FULL', message: '设置存储空间不足', retryable: false } };
          if (args.expectedVersion !== profile.version || args.expectedRevision !== profile.revision) return { ok: false,
            error: { code: 'CONFLICT', message: '配置已变化', retryable: false } };
          profile = { ...profile, version: profile.version + 1, revision: 'b'.repeat(64), settings: args.settings as Record<string, unknown> };
          return ok({ version: profile.version, revision: profile.revision });
        }
        case 'list_font_families': return ok({ families: ['Arial', 'Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_files': return ok({ grants: [ref], failures: [] });
        case 'open_document': return ok({ documentId: '11111111-1111-4111-8111-111111111111', ref, metadata,
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: 'body', newlineMap: { documentVersion: 0, endings: [] } } });
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'test-watch' });
        case 'stop_watch': return ok({ stopped: true });
        case 'release_document': return ok({ released: true });
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await sidebarSection(page, '最近打开');
  await expect(page.locator('.document-view .cm-content')).toHaveText('body');
  await expect(page.locator('.recent-panel').getByRole('button', { name: '打开settings-test.txt', exact: true })).toBeVisible();
});

test('shortcut management preserves the settings draft and searching privacy finds appearance fields', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('22');
  await dialog.getByRole('button', { name: '自定义快捷键…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '命令面板', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('22');
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '22px');
  await dialog.getByRole('tab', { name: '隐私', exact: true }).click();
  await dialog.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('字体');
  await expect(dialog.getByRole('combobox', { name: '编辑器字体', exact: true })).toBeVisible();
  await expect(dialog.locator('.settings-search-scope')).toContainText('全部分类');
  await expect(dialog.locator('.settings-row').filter({ hasText: '编辑器字体' })).toContainText('外观');
  await dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '14px');
});

test('the editor font picker keeps every installed font available after a selection', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const font = dialog.getByRole('combobox', { name: '编辑器字体', exact: true });
  await font.fill('Consolas');
  await dialog.getByRole('button', { name: '展开编辑器字体列表', exact: true }).click();
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option', { name: 'Arial', exact: true })).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'Consolas', exact: true })).toBeVisible();
  await dialog.getByRole('option', { name: 'Arial', exact: true }).click();
  await expect(font).toHaveValue('Arial');
});

test('invalid settings stay next to their fields and provide a route back from other categories', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const size = dialog.getByRole('spinbutton', { name: '编辑字号', exact: true });
  await size.fill('99');
  await expect(size).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('#setting-error-fontSize')).toContainText('8–40');
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await dialog.getByRole('tab', { name: '隐私', exact: true }).click();
  await dialog.locator('.settings-error-links').getByRole('button', { name: '编辑字号', exact: true }).click();
  await expect(size).toBeFocused();
  await size.fill('20');
  await expect(size).toHaveAttribute('aria-invalid', 'false');
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await expect(dialog.locator('.settings-error-links')).toHaveCount(0);
});

test('welcome page offers a recent file directly after closing its tab', async ({ page }) => {
  await page.getByRole('button', { name: '关闭 settings-test.txt', exact: true }).click();
  const recent = page.getByRole('region', { name: '继续上次编辑', exact: true });
  await expect(recent).toBeVisible();
  await recent.getByRole('button', { name: /settings-test.txt/ }).click();
  await expect(page.locator('.document-view .cm-content')).toHaveText('body');
});

test('system theme follows media and cancelling a theme/font preview restores the prior effective settings', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const origin = page.getByRole('button', { name: '打开设置', exact: true });
  await origin.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.getByRole('searchbox', { name: '搜索设置', exact: true })).toBeFocused();
  await dialog.getByRole('combobox', { name: '主题', exact: true }).click();
  await dialog.getByRole('option', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await dialog.getByRole('combobox', { name: '编辑器字体', exact: true }).fill('Missing-local-font-fixture');
  await expect(dialog.getByRole('note')).toContainText('未找到本机字体');
  await dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '20px');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible(); await expect(origin).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '14px');
});

test('real CodeMirror view preferences preview without changing document text, dirty state or undo', async ({ page }) => {
  const editor = page.locator('.document-view .cm-content');
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' draft');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('checkbox', { name: '自动换行', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: '显示行号', exact: true }).uncheck();
  await expect(page.locator('.document-view .cm-content')).not.toHaveClass(/cm-lineWrapping/);
  await expect(page.locator('.document-view .cm-lineNumbers')).toHaveCount(0);
  await expect(editor).toHaveText('body draft');
  await dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
  await expect(page.locator('.document-view .cm-content')).toHaveClass(/cm-lineWrapping/);
  await expect(page.locator('.document-view .cm-lineNumbers')).toHaveCount(1);
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('body');
  await expect(page.getByRole('status')).toContainText('未修改');
});

test('import has an explicit preview, retains unknown fields and failed persistence remains visibly temporary at 200%', async ({ page }) => {
  const baselineVersion = await page.evaluate(() => (Reflect.get(window, 'settingsFixture') as { get: () => { version: number } }).get().version);
  expect(baselineVersion).toBe(2); // Initial settings plus the successful-open recent history write.
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByLabel('导入设置文件', { exact: true }).setInputFiles({ name: 'settings.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, settings: { theme: 'dark', fontSize: 18, futureImport: { retained: true } } })) });
  const preview = dialog.getByRole('region', { name: '导入设置预览', exact: true });
  await expect(preview).toContainText('fontSize');
  expect(await page.evaluate(() => (Reflect.get(window, 'settingsFixture') as { get: () => { version: number } }).get().version)).toBe(baselineVersion);
  await preview.getByRole('button', { name: '应用导入预览', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('设置已保存');
  const profile = await page.evaluate(() => (Reflect.get(window, 'settingsFixture') as { get: () => { settings: Record<string, unknown> } }).get());
  expect(profile.settings.future).toEqual({ retain: true }); expect(profile.settings.futureImport).toEqual({ retained: true });
  await dialog.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('编辑字号');
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: '主题', exact: true })).toHaveCount(0);
  await dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
  await page.evaluate(() => { (Reflect.get(window, 'settingsFixture') as { fail: () => void }).fail(); document.documentElement.style.zoom = '2'; });
  const save = dialog.getByRole('button', { name: '保存设置', exact: true });
  await expect(save).toBeInViewport(); await save.click();
  await expect(dialog.getByRole('alert')).toContainText('仅本次生效');
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '20px');
  await page.screenshot({ path: test.info().outputPath('settings-200.png') });
});

test('settings category tabs support roving focus, arrows, Home/End and a labelled content panel without saving previews', async ({ page }) => {
  const origin = page.getByRole('button', { name: '打开设置', exact: true });
  await expect(origin).toHaveAttribute('title', '打开设置');
  await origin.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const tabs = dialog.getByRole('tablist', { name: '设置分类', exact: true });
  const all = tabs.getByRole('tab', { name: '全部', exact: true });
  const appearance = tabs.getByRole('tab', { name: '外观', exact: true });
  const editor = tabs.getByRole('tab', { name: '编辑器', exact: true });
  const system = tabs.getByRole('tab', { name: '系统', exact: true });
  await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
  await page.keyboard.press('Tab');
  await expect(all).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(appearance).toBeFocused();
  await expect(appearance).toHaveAttribute('aria-selected', 'true');
  const panel = dialog.getByRole('tabpanel', { name: '外观', exact: true });
  await expect(appearance).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!);
  await expect(panel).toHaveAttribute('aria-labelledby', (await appearance.getAttribute('id'))!);
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(panel).toBeFocused();
  await expect(panel).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('combobox', { name: '主题', exact: true })).toBeFocused();
  await panel.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
  await appearance.focus();
  await page.keyboard.press('ArrowDown');
  await expect(editor).toBeFocused();
  await expect(dialog.getByRole('tabpanel', { name: '编辑器', exact: true }).getByRole('checkbox', { name: '显示行号', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(system).toBeFocused();
  await expect(dialog.getByRole('tabpanel', { name: '系统', exact: true })
    .getByRole('region', { name: 'Windows 系统集成', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(all).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(system).toBeFocused();
  await page.keyboard.press('Home');
  await expect(all).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('20');
  expect(await page.evaluate(() => (Reflect.get(window, 'settingsFixture') as { get: () => { version: number } }).get().version)).toBe(2);
  await page.keyboard.press('Escape');
  await expect(origin).toBeFocused();
  await expect(page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '14px');
});

test('cross-category search keeps its Tab exit, ignores composition arrows and returns from shortcut management', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('编辑字号');
  await page.keyboard.press('Tab');
  await page.keyboard.press('End');
  const system = dialog.getByRole('tab', { name: '系统', exact: true });
  await expect(system).toBeFocused();
  const panel = dialog.getByRole('tabpanel', { name: '系统', exact: true });
  await expect(panel.getByRole('spinbutton', { name: '编辑字号', exact: true })).toBeVisible();
  await system.dispatchEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true });
  await expect(system).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(panel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(system).toBeFocused();
  await page.keyboard.press('Home');
  await expect(dialog.getByRole('tab', { name: '全部', exact: true })).toBeFocused();
  const shortcuts = dialog.getByRole('button', { name: '自定义快捷键…', exact: true });
  await shortcuts.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '命令面板', exact: true }).getByRole('combobox', { name: '搜索命令', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(shortcuts).toBeFocused();
});

test('compact settings tabs update orientation and keep previews through resizing, high contrast and 200% CSS zoom', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const tabs = dialog.getByRole('tablist', { name: '设置分类', exact: true });
  const appearance = tabs.getByRole('tab', { name: '外观', exact: true });
  await appearance.click();
  await dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
  await appearance.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '编辑器', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(appearance).toBeFocused();
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('20');
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
  await expect(appearance).toHaveCSS('outline-style', 'solid');
  await expect(appearance).toHaveCSS('outline-width', '2px');
  await page.screenshot({ path: test.info().outputPath('settings-category-compact.png') });
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
  await expect(appearance).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '取消并还原预览', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('20');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeFocused();
});

import { test, expect } from './test-fixture';

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
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
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
  await dialog.getByRole('combobox', { name: '主题', exact: true }).selectOption('light');
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
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByLabel('导入设置文件', { exact: true }).setInputFiles({ name: 'settings.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, settings: { theme: 'dark', fontSize: 18, futureImport: { retained: true } } })) });
  const preview = dialog.getByRole('region', { name: '导入设置预览', exact: true });
  await expect(preview).toContainText('fontSize');
  expect(await page.evaluate(() => (Reflect.get(window, 'settingsFixture') as { get: () => { version: number } }).get().version)).toBe(1);
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

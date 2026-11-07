import { expect, test, type Page } from './test-fixture';

const storageKey = 'featherpad.test.font-settings';
async function installSettings(page: Page, fontSize = 14) {
  await page.addInitScript(({ key, initialSize }) => {
    interface Profile {
      schemaVersion: 1; version: number; revision: string;
      settings: { fontSize: number; future: { keep: boolean }; recentHistoryItems: { schemaVersion: 1; entries: [] } };
      warning: null; recoveryCopies: [];
    }
    let profile: Profile = JSON.parse(localStorage.getItem(key) ?? 'null') as Profile | null ?? {
      schemaVersion: 1, version: 1, revision: 'a'.repeat(64),
      settings: { fontSize: initialSize, future: { keep: true }, recentHistoryItems: { schemaVersion: 1, entries: [] } },
      warning: null, recoveryCopies: [],
    };
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, 'fontFailWrites', false);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case 'load_settings': return ok(profile);
        case 'list_font_families': return ok({ families: ['Cascadia Mono'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'save_settings': {
          if (Reflect.get(window, 'fontFailWrites')) return { ok: false,
            error: { code: 'DISK_FULL', message: '受控设置写入失败', retryable: false } };
          if (args.expectedVersion !== profile.version || args.expectedRevision !== profile.revision) {
            return { ok: false, error: { code: 'CONFLICT', message: '设置版本变化', retryable: false } };
          }
          profile = { ...profile, version: profile.version + 1,
            revision: (profile.version + 1).toString(16).padStart(64, '0'), settings: args.settings as Profile['settings'] };
          localStorage.setItem(key, JSON.stringify(profile));
          return ok({ version: profile.version, revision: profile.revision });
        }
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  }, { key: storageKey, initialSize: fontSize });
}

const fontSize = (page: Page) => page.locator('.cm-scroller').evaluate(element => getComputedStyle(element).fontSize);
const persistedSize = (page: Page) => page.evaluate(key => {
  const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { settings: { fontSize: number } } | null;
  return value?.settings.fontSize ?? null;
}, storageKey);
async function createDocumentAfterStartup(page: Page) {
  await expect(page.getByRole('button', { name: '新建文本', exact: true })).toBeVisible();
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('textbox', { name: '文档内容', exact: true })).toBeVisible();
}

test('Web mock: keyboard and real Ctrl+wheel persist editor font size without zooming the page or changing undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installSettings(page);
  await page.goto('/');
  await createDocumentAfterStartup(page);
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  await editor.focus();
  await page.keyboard.insertText('缩放正文😀');
  await page.keyboard.press('Control+a');
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  const pageScale = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, zoom: document.documentElement.style.zoom }));
  await page.keyboard.press('Control+=');
  await expect.poll(() => fontSize(page)).toBe('15px');
  await page.keyboard.press('Control+Shift+Equal');
  await expect.poll(() => fontSize(page)).toBe('16px');
  await page.keyboard.press('Control+-');
  await expect.poll(() => fontSize(page)).toBe('15px');
  await editor.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(() => fontSize(page)).toBe('16px');
  await expect.poll(() => persistedSize(page)).toBe(16);
  expect(await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, zoom: document.documentElement.style.zoom }))).toEqual(pageScale);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  await expect(page.getByRole('status')).toContainText('16px');
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as unknown, storageKey);
  expect(stored).toMatchObject({ settings: { fontSize: 16, future: { keep: true }, recentHistoryItems: { schemaVersion: 1, entries: [] } } });
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await expect(page.getByRole('tab', { name: /无标题 1/ })).not.toContainText('●');
  await page.reload();
  await createDocumentAfterStartup(page);
  await expect.poll(() => fontSize(page)).toBe('16px');
  await page.keyboard.press('Control+0');
  await expect.poll(() => fontSize(page)).toBe('14px');
  await expect.poll(() => persistedSize(page)).toBe(14);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('font-zoom-restored.png') });
});

test('Web mock: a failed font preference write remains visible for the session and can be saved by the next change', async ({ page }) => {
  await installSettings(page);
  await page.goto('/');
  await createDocumentAfterStartup(page);
  await page.evaluate(() => Reflect.set(window, 'fontFailWrites', true));
  await page.keyboard.press('Control+=');
  await expect.poll(() => fontSize(page)).toBe('15px');
  await page.locator('.status-notices > summary').click();
  await expect(page.getByText('编辑字号仅本次生效：受控设置写入失败', { exact: true })).toBeVisible();
  expect(await persistedSize(page)).toBeNull();
  await page.evaluate(() => Reflect.set(window, 'fontFailWrites', false));
  await page.keyboard.press('Control+=');
  await expect.poll(() => fontSize(page)).toBe('16px');
  await expect.poll(() => persistedSize(page)).toBe(16);
  await expect(page.getByText('编辑字号仅本次生效：受控设置写入失败', { exact: true })).toHaveCount(0);
});

test('Web mock: zoom respects maximum size, remapping, modal boundaries and editor-only wheel scope', async ({ page }) => {
  await installSettings(page, 40);
  await page.goto('/');
  await createDocumentAfterStartup(page);
  await expect.poll(() => fontSize(page)).toBe('40px');
  await page.keyboard.press('Control+=');
  await expect.poll(() => fontSize(page)).toBe('40px');
  expect(await persistedSize(page)).toBeNull();
  await page.keyboard.press('Control+Shift+p');
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true });
  await palette.getByRole('combobox', { name: '搜索命令', exact: true }).fill('font zoom in');
  await palette.getByRole('button', { name: '修改快捷键', exact: true }).click();
  await palette.getByRole('textbox', { name: '快捷键组合', exact: true }).fill('Ctrl+9');
  await palette.getByRole('button', { name: '应用快捷键', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+0');
  await expect.poll(() => fontSize(page)).toBe('14px');
  await page.keyboard.press('Control+9');
  await expect.poll(() => fontSize(page)).toBe('15px');
  await page.locator('.cm-content').dispatchEvent('wheel', { ctrlKey: false, deltaY: -120 });
  await page.getByRole('complementary', { name: '资源管理器' }).dispatchEvent('wheel', { ctrlKey: true, deltaY: -120 });
  await expect.poll(() => fontSize(page)).toBe('15px');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await page.keyboard.press('Control+9');
  await page.locator('.cm-content').dispatchEvent('wheel', { ctrlKey: true, deltaY: -120 });
  await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('15');
  await dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
  await expect.poll(() => fontSize(page)).toBe('15px');
});

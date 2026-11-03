import { expect, test } from './test-fixture';

test('HTML static preview isolates scripts, navigation, forms and remote resources without modifying source or undo', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) requests.push(request.url()); });
  await page.goto('/'); await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式', exact: true }).selectOption('html');
  const source = '<h1 onclick="parent.htmlPwned=1">安全静态内容</h1><script>parent.htmlPwned=1</script><form action="https://example.com/post"><input autofocus onfocus="parent.htmlPwned=1"></form><a href="https://example.com/go" target="_top">链接不导航</a><iframe src="https://example.com/frame"></iframe><style>@import "https://example.com/css";</style><img src="https://example.com/leak" alt="远程图"><meta http-equiv="refresh" content="0;url=https://example.com/go">';
  const editor = page.locator('.cm-content'); await editor.focus(); await page.keyboard.insertText(source);
  const original = await page.locator('.cm-line').allTextContents();
  const modes = page.getByRole('group', { name: 'HTML视图', exact: true });
  await modes.getByRole('button', { name: '静态预览', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="HTML静态预览"]');
  await expect(frame.getByRole('heading', { name: '安全静态内容', exact: true })).toBeVisible();
  await expect(frame.locator('script,iframe,form,input,a[href],[onclick],img[src^="http"],link,meta[http-equiv="refresh"]')).toHaveCount(0);
  await expect(frame.getByText('[图片未加载：远程图]', { exact: true })).toBeVisible();
  const isolation = await frame.locator('body').evaluate(() => {
    let isolated = false; try { void parent.document; } catch { isolated = true; }
    return { isolated, ipc: '__TAURI_INTERNALS__' in window };
  });
  expect(isolation).toEqual({ isolated: true, ipc: false });
  await frame.getByText('链接不导航', { exact: true }).click();
  expect(page.url()).toContain('127.0.0.1:1420');
  expect(await page.evaluate(() => Reflect.get(window, 'htmlPwned'))).toBeUndefined(); expect(requests).toEqual([]);
  await modes.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(original);
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(['']);
});

test('HTML images need the explicit scope for unnamed documents and only verified embedded bytes reach the frame', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let version = 0;
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null, settings: {}, warning: null, recoveryCopies: [] });
        case 'save_settings': return ok({ version: ++version, revision: version.toString(16).padStart(64, '0') });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant: { grantId: 'html-directory', relativePath: '' }, displayName: 'HTML资源' });
        case 'read_preview_resource': {
          if (args.documentId !== null || !args.directory || typeof args.directory !== 'object' || Reflect.get(args.directory, 'grantId') !== 'html-directory') throw new Error('Missing explicit HTML scope');
          return ok({ mime: 'image/gif', dataBase64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', sizeBytes: 42, width: 1, height: 1 });
        }
        default: throw new Error(`Unexpected HTML fixture command ${command}`);
      }
    } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式', exact: true }).selectOption('html');
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('<h2>本地HTML</h2><img src="本地图.gif" alt="授权图">');
  await page.getByRole('group', { name: 'HTML视图', exact: true }).getByRole('button', { name: '静态预览', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="HTML静态预览"]');
  await expect(frame.getByText('[图片未加载：授权图]', { exact: true })).toBeVisible();
  await page.locator('.html-reading .markdown-resource-details > summary').click();
  await page.getByRole('button', { name: '授权或选择HTML资源目录…', exact: true }).click();
  const image = frame.getByRole('img', { name: '授权图', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await image.getAttribute('src')).toMatch(/^data:image\/gif;base64,/);
});

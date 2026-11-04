import { menuItem } from '../ui-actions';
import { expect, test, type Page } from './test-fixture';

async function fixture(page: Page, svg: boolean) {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="parent.imagePwned=1"><script>parent.imagePwned=1</script><rect width="100" height="50" fill="green"/><image href="https://example.com/leak"/><foreignObject><p>unsafe</p></foreignObject></svg>';
  const image = svg ? { mime: 'image/svg+xml', dataBase64: Buffer.from(source).toString('base64'), sizeBytes: Buffer.byteLength(source), width: null, height: null }
    : { mime: 'image/gif', dataBase64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', sizeBytes: 42, width: 1, height: 1 };
  await page.addInitScript(({ image, svg, source }) => {
    if (window.top !== window) return;
    let settingsVersion = 0;
    const id = '11111111-1111-4111-8111-111111111111';
    const ref = { grantId: 'image-grant', relativePath: '' }, revision = 'a'.repeat(64);
    const metadata = { displayPath: `E:\\fixtures\\image.${svg ? 'svg' : 'gif'}`, sizeBytes: image.sizeBytes,
      modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: revision };
    const opened = { documentId: id, canonicalIdentity: 'b'.repeat(64), ref, metadata, format: { encoding: 'binary', bom: 'none', lineEnding: 'lf' },
      mode: 'image-readonly', warnings: [], content: { kind: 'image', image } };
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null, settings: {}, warning: null, recoveryCopies: [] });
        case 'save_settings': return ok({ version: ++settingsVersion, revision: settingsVersion.toString(16).padStart(64, '0') });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_files': return ok({ grants: [ref], failures: [] });
        case 'open_document': return ok(opened);
        case 'reopen_with_encoding': return ok({ ...opened, format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' }, mode: 'normal', content: { kind: 'text', text: source, newlineMap: { documentVersion: 0, endings: [] } } });
        case 'stat_document': return ok(metadata);
        case 'reload_document': return ok(opened);
        case 'start_watch': return ok({ watchId: 'image-watch' });
        case 'stop_watch': return ok({ stopped: true });
        case 'release_document': return ok({ released: true });
        default: throw new Error(`Unexpected image fixture command ${command}`);
      }
    } });
  }, { image, svg, source });
}

test('GIF opens in a readonly tab with bounded zoom, actual decoded dimensions and a paused canvas frame', async ({ page }) => {
  await fixture(page, false); await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('img', { name: 'image.gif', exact: true })).toBeVisible();
  await expect(page.getByLabel('图片尺寸与大小', { exact: true })).toContainText('1 × 1');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect((await menuItem(page, '另存为'))).toBeDisabled();
  await page.getByRole('button', { name: '原尺寸', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '图片缩放百分比', exact: true })).toHaveValue('100');
  await page.getByRole('spinbutton', { name: '图片缩放百分比', exact: true }).fill('999');
  await expect(page.getByRole('spinbutton', { name: '图片缩放百分比', exact: true })).toHaveValue('800');
  await page.getByRole('button', { name: '暂停GIF动画', exact: true }).click();
  await expect(page.getByLabel('GIF暂停帧', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'image.gif', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '恢复GIF动画', exact: true }).click();
  await expect(page.getByRole('img', { name: 'image.gif', exact: true })).toBeVisible();
});

test('SVG removes active and remote content; only explicit source reopen enables text editing', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) requests.push(request.url()); });
  await fixture(page, true); await page.goto('/'); await page.getByRole('button', { name: '打开文件', exact: true }).click();
  const image = page.getByRole('img', { name: 'image.svg', exact: true }); await expect(image).toBeVisible();
  const data = await image.getAttribute('src');
  expect(Buffer.from(data!.split(',')[1]!, 'base64').toString()).not.toMatch(/<script|onload|foreignObject|href=|https:\/\//);
  expect(await page.evaluate(() => Reflect.get(window, 'imagePwned'))).toBeUndefined(); expect(requests).toEqual([]);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '作为文本打开（UTF-8）', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('<svg');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, 'imagePwned'))).toBeUndefined(); expect(requests).toEqual([]);
});

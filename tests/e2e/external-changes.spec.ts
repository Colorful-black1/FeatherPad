import { test, expect } from './test-fixture';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const documentId = '11111111-1111-4111-8111-111111111111';
    const ref = { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' };
    let text = 'original'; let revision = 'a'.repeat(64); let missing = false;
    const format = { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' };
    const metadata = () => ({ displayPath: 'E:\\fixture\\external.txt', sizeBytes: text.length,
      modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false, diskRevision: revision });
    const opened = () => ({ documentId, ref, metadata: metadata(), format, mode: 'normal', warnings: [],
      content: { kind: 'text', text, newlineMap: { documentVersion: 0, endings: Array.from(text.matchAll(/\n/g), () => 'lf') } } });
    Reflect.set(window, 'externalFixture', {
      change: (value: string, next: string) => { text = value; revision = next.repeat(64); missing = false; },
      remove: () => { missing = true; },
    });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'choose_files': return ok({ grants: [ref], failures: [] });
        case 'open_document': case 'get_disk_snapshot': return ok(opened());
        case 'start_watch': return ok({ watchId: 'web-watch' });
        case 'stop_watch': return ok({ stopped: true });
        case 'stat_document': return missing ? { ok: false, error: { code: 'NOT_FOUND', message: '文件不存在', retryable: false } } : ok(metadata());
        case 'reload_document': return args.expectedDiskRevision === revision ? ok(opened())
          : { ok: false, error: { code: 'CONFLICT', message: '磁盘在确认后再次变化', retryable: false } };
        case 'save_document_as': {
          const saved = String(args.text); text = saved; revision = 'f'.repeat(64); missing = false;
          return ok({ documentId, ref, metadata: metadata(), ack: { documentVersion: args.documentVersion,
            diskRevision: revision, sizeBytes: saved.length, savedAt: '2026-11-02T00:00:01Z' } });
        }
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.locator('.document-view .cm-content')).toHaveText('original');
});

test('clean focus reload updates the mounted editor; dirty comparison preserves text and supports keyboard cancellation', async ({ page }) => {
  await page.evaluate(() => {
    (Reflect.get(window, 'externalFixture') as { change: (text: string, rev: string) => void }).change('external', 'b');
    window.dispatchEvent(new Event('focus'));
  });
  const editor = page.locator('.document-view .cm-content');
  await expect(editor).toHaveText('external');
  const banner = page.getByRole('region', { name: '外部文件变化', exact: true });
  await banner.getByRole('button', { name: '知道了' }).click();
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' draft');
  await page.evaluate(() => {
    (Reflect.get(window, 'externalFixture') as { change: (text: string, rev: string) => void }).change('new disk', 'c');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(banner).toContainText('当前未保存内容仍保留');
  await banner.getByRole('button', { name: '比较磁盘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前缓冲与磁盘', exact: true });
  await expect(dialog.getByLabel('当前缓冲快照', { exact: true })).toHaveText('external draft');
  await expect(dialog.getByLabel('磁盘快照', { exact: true })).toHaveText('new disk');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(banner.getByRole('button', { name: '比较磁盘', exact: true })).toBeFocused();
  await expect(editor).toHaveText('external draft');
});

test('stale comparison cannot reload; a new confirmation protects and loads the newer disk revision at 200%', async ({ page }) => {
  const editor = page.locator('.document-view .cm-content');
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' draft');
  const change = async (text: string, rev: string) => page.evaluate(({ text, rev }) => {
    (Reflect.get(window, 'externalFixture') as { change: (text: string, rev: string) => void }).change(text, rev);
    window.dispatchEvent(new Event('focus'));
  }, { text, rev });
  await change('disk one', 'b');
  const banner = page.getByRole('region', { name: '外部文件变化', exact: true });
  await banner.getByRole('button', { name: '比较磁盘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前缓冲与磁盘', exact: true });
  await change('disk two', 'c');
  await expect(dialog.getByRole('button', { name: '保护草稿并重新载入', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status').filter({ hasText: '版本已有新变化' })).toBeVisible();
  await expect(editor).toHaveText('original draft');
  await dialog.getByRole('button', { name: '保留当前内容' }).click();
  await banner.getByRole('button', { name: '重新核对', exact: true }).click();
  await banner.getByRole('button', { name: '重新载入…', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const reload = page.getByRole('dialog', { name: '重新载入磁盘文件', exact: true });
  await expect(reload.getByRole('button', { name: '保护草稿并重新载入', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('external-reload-200.png') });
  await reload.getByRole('button', { name: '保护草稿并重新载入', exact: true }).click();
  await expect(editor).toHaveText('disk two');
});

test('external deletion retains clean text and Save As returns a clean buffer', async ({ page }) => {
  await page.evaluate(() => {
    (Reflect.get(window, 'externalFixture') as { remove: () => void }).remove();
    window.dispatchEvent(new Event('focus'));
  });
  const banner = page.getByRole('region', { name: '外部文件变化', exact: true });
  await expect(banner).toContainText('文件不存在');
  await expect(page.locator('.document-view .cm-content')).toHaveText('original');
  await banner.getByRole('button', { name: '另存当前内容…', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('未修改');
  await expect(banner).not.toBeVisible();
});

test('conflict diff highlights and navigates separate changes in read-only snapshots without modifying the buffer', async ({ page }) => {
  const editor = page.locator('.document-view .cm-content');
  await editor.focus(); await page.keyboard.press('Control+a');
  await page.keyboard.insertText('a\nlocal1\nb\nlocal2\nc');
  await page.evaluate(() => {
    (Reflect.get(window, 'externalFixture') as { change: (text: string, rev: string) => void }).change('a\ndisk1\nb\ndisk2\nc', 'b');
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('button', { name: '比较磁盘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前缓冲与磁盘', exact: true });
  await expect(dialog.getByRole('status').filter({ hasText: '差异 1 / 2' })).toBeVisible();
  await expect(dialog.locator('.diff-changed-line')).toHaveCount(4);
  await dialog.getByRole('button', { name: '下一处差异', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '差异 2 / 2' })).toBeVisible();
  await dialog.getByRole('button', { name: '上一处差异', exact: true }).click();
  const memory = dialog.getByLabel('当前缓冲快照', { exact: true });
  await expect(memory).toHaveAttribute('contenteditable', 'false');
  await memory.focus(); await page.keyboard.insertText('SHOULD NOT WRITE');
  await expect(memory).toHaveText('alocal1blocal2c');
  await dialog.getByRole('button', { name: '保留当前内容', exact: true }).click();
  await expect(editor).toHaveText('alocal1blocal2c');
});

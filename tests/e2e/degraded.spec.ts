import { expect, test } from './test-fixture';

test('Web mock: degraded complete text remains editable and sends the entire buffer to save', async ({ page }) => {
  await page.addInitScript(() => {
    const text = `${`${'x'.repeat(511)}\n`.repeat(4096)}!`;
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, request: { text: string; documentVersion: number }) => {
      if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'degraded-grant', relativePath: '' }], failures: [] } };
      if (command === 'open_document') return { ok: true, value: {
        documentId: 'degraded-document', ref: { grantId: 'degraded-grant', relativePath: '' },
        metadata: { displayPath: '降级文本.txt', sizeBytes: text.length, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'before' },
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'degraded',
        warnings: ['已使用纯文本降级模式：语法高亮、补全、折叠和实时 Markdown 已关闭。'],
        content: { kind: 'text', text, newlineMap: { documentVersion: 0, endings: Array.from({ length: 4096 }, () => 'lf') } },
      } };
      if (command === 'save_document') {
        Reflect.set(window, 'degradedSaveComplete', request.text === `中文😀${text}`);
        return { ok: true, value: { documentVersion: request.documentVersion, diskRevision: 'after',
          savedAt: '2026-11-01T00:00:00Z', sizeBytes: new TextEncoder().encode(request.text).length } };
      }
      throw new Error('Unexpected Web mock command');
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByText('纯文本 · 降级', { exact: true })).toBeVisible();
  await expect(page.getByText(/^已使用纯文本降级模式/)).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('中文😀');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('未修改');
  expect(await page.evaluate(() => Reflect.get(window, 'degradedSaveComplete'))).toBe(true);
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(page.getByText('纯文本 · 降级', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await expect(page.locator('.cm-editor')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('degraded-web-200.png') });
});

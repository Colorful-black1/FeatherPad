import { menuItem } from '../ui-actions';
import { expect, test } from './test-fixture';

test('Web mock: first-save cancellation preserves the draft and copy keeps the source dirty', async ({ page }) => {
  await page.addInitScript(() => {
    const requests: { documentId: string; documentVersion: number; text: string; intent: string }[] = [];
    Reflect.set(window, 'destinationRequests', requests);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: typeof requests[number]) => {
      if (command !== 'save_document_as') throw new Error('Unexpected Web mock command');
      requests.push(args);
      if (requests.length === 1) return { ok: false, error: { code: 'CANCELLED', message: 'controlled cancel', retryable: false } };
      const sizeBytes = new TextEncoder().encode(args.text).length;
      const diskRevision = `destination-${requests.length}`;
      return { ok: true, value: { documentId: args.documentId, ref: { grantId: args.intent === 'copy' ? 'copy-grant' : 'saved-grant', relativePath: '' },
        metadata: { displayPath: args.intent === 'copy' ? `E:\\fixtures\\${'long-controlled-directory-'.repeat(5)}副本.txt` : '保存 文件.txt', sizeBytes, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision },
        ack: { documentVersion: args.documentVersion, diskRevision, savedAt: '2026-11-01T00:00:00Z', sizeBytes } } };
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.keyboard.insertText('中文草稿😀');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, 'destinationRequests') as unknown[]).length)).toBe(1);
  await expect(page.getByRole('tab')).toContainText('无标题 1');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveText('中文草稿😀');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab')).toHaveText('保存 文件.txt');
  await expect(page.getByRole('status')).toContainText('未修改');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 副本中的输入');
  await (await menuItem(page, '保存副本')).click();
  await expect(page.getByText(/^副本已保存：E:/)).not.toBeVisible();
  await expect(page.locator('#editor-area > .notice')).toHaveCount(0);
  await page.locator('.status-notices > summary').click();
  await expect(page.getByText(/^副本已保存：E:/)).toBeVisible();
  await expect(page.locator('.notice[data-tone="success"]')).toContainText('副本已保存');
  await expect(page.getByRole('tab')).toContainText('保存 文件.txt');
  await expect(page.getByRole('tab')).toContainText('●');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  const requests = await page.evaluate(() => Reflect.get(window, 'destinationRequests') as { intent: string }[]);
  expect(requests.map(request => request.intent)).toEqual(['save-as', 'save-as', 'copy']);
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(page.getByRole('button', { name: '关闭提示', exact: true })).toBeInViewport();
  await expect(page.locator('.cm-editor')).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('save-as-web.png') });
});

test('Web mock: a read-only complete document becomes editable after saving elsewhere', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: { documentId: string; documentVersion: number }) => {
      const metadata = { displayPath: 'readonly.txt', sizeBytes: 4, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: true, diskRevision: 'original' };
      if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'original-grant', relativePath: '' }], failures: [] } };
      if (command === 'open_document') return { ok: true, value: { documentId: 'readonly-document', ref: { grantId: 'original-grant', relativePath: '' }, metadata,
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal', content: { kind: 'text', text: 'text', newlineMap: { documentVersion: 0, endings: [] } } } };
      if (command === 'save_document_as') return { ok: true, value: { documentId: args.documentId, ref: { grantId: 'writable-grant', relativePath: '' },
        metadata: { ...metadata, displayPath: 'writable.txt', isReadOnly: false, diskRevision: 'new' },
        ack: { documentVersion: args.documentVersion, diskRevision: 'new', savedAt: metadata.modifiedAt, sizeBytes: 4 } } };
      throw new Error('Unexpected mock command');
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await (await menuItem(page, '另存为')).click();
  await expect(page.getByRole('tab')).toHaveText('writable.txt');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' editable');
  await expect(page.locator('.cm-content')).toHaveText('text editable');
  await expect(page.getByRole('status')).toContainText('未保存修改');
});

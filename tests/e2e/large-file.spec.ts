import { expect, test } from '@playwright/test';

test('Web mock pages bounded large-file chunks without accumulating text or exposing save actions', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, 'largeFileOffsets', []);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, request: { byteOffset?: number; mode?: string }) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'large-grant', relativePath: '' }], failures: [] } };
        if (command === 'open_document') return { ok: true, value: {
          documentId: 'large-document', ref: { grantId: 'large-grant', relativePath: '' },
          metadata: { displayPath: '大文件.log', sizeBytes: 20 * 1024 * 1024, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'large-revision' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: ['文件以只读分块模式打开'],
          mode: 'large-readonly',
          content: { kind: 'chunked', handleId: 'chunk-handle', initialChunk: {
            byteStart: 0, byteEnd: 6, firstLine: 1, text: 'first\n', hasMore: true,
          }, totalBytes: 20 * 1024 * 1024 },
        } };
        if (command === 'read_document_chunk') {
          const offsets = Reflect.get(window, 'largeFileOffsets') as number[];
          offsets.push(request.byteOffset as number);
          if (request.byteOffset === 6) return {
            ok: true,
            value: { byteStart: 6, byteEnd: 11, firstLine: 2, text: 'next\n', hasMore: false },
          };
          if (request.byteOffset === 0) return {
            ok: true,
            value: { byteStart: 0, byteEnd: 6, firstLine: 1, text: 'first\n', hasMore: true },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('region', { name: '大文件分块只读视图' })).toContainText('first');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '上一块' })).toBeDisabled();
  await page.getByRole('button', { name: '下一块' }).click();
  await expect(page.locator('.large-file-text')).toHaveText('next\n');
  await expect(page.locator('.large-file-text')).not.toContainText('first');
  await expect(page.getByRole('button', { name: '已到文件末尾' })).toBeDisabled();
  await page.getByRole('button', { name: '上一块' }).click();
  await expect(page.locator('.large-file-text')).toHaveText('first\n');
  await expect(page.getByText(/第 1 页/)).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'largeFileOffsets'))).toEqual([6, 0]);
});

test('Web mock requires an explicit action before showing a head preview', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, request: { mode?: string }) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'head-grant', relativePath: '' }], failures: [] } };
        if (command !== 'open_document') throw new Error(`Unexpected command: ${command}`);
        if (request.mode !== 'head-preview') return {
          ok: false,
          error: { code: 'TOO_LARGE', message: '文件超过100MiB；请明确选择前1MiB只读预览。', retryable: false },
        };
        return { ok: true, value: {
          documentId: 'head-document', ref: { grantId: 'head-grant', relativePath: '' },
          metadata: { displayPath: '超大文件.txt', sizeBytes: 100 * 1024 * 1024 + 1, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'head-revision' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: ['内容已截断且只读'],
          mode: 'head-preview',
          content: { kind: 'head', text: 'preview only', previewBytes: 12, totalBytes: 100 * 1024 * 1024 + 1, truncated: true },
        } };
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByText(/不会自动加载完整内容/)).toBeVisible();
  await expect(page.locator('.large-file-text')).toHaveCount(0);
  await page.getByRole('button', { name: '预览所选文件 1 的前1MiB' }).click();
  await expect(page.getByRole('region', { name: '大文件限量预览' })).toContainText('preview only');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});

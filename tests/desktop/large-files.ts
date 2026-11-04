import { menuItem } from '../ui-actions';
import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { measureProcessTree } from './process-metrics';

type OpenLargeFixture = (target: string, action: 'open-large-chunk' | 'open-head-preview') => Promise<void>;

export async function verifyNativeLargeFiles(
  page: Page,
  dataDir: string,
  openLargeFixture: OpenLargeFixture,
  evidence: string,
  processId: number,
) {
  const chunkTarget = path.join(dataDir, '大文件 20MiB😀.txt');
  const chunk = Buffer.alloc(20 * 1024 * 1024, 'x');
  for (let index = 255; index < chunk.length; index += 256) chunk[index] = 10;
  await writeFile(chunkTarget, chunk);
  const chunkHash = createHash('sha256').update(chunk).digest('hex');

  const chunkOpenStarted = performance.now();
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await openLargeFixture(chunkTarget, 'open-large-chunk');
  await expect(page.getByRole('tab', { name: '大文件 20MiB😀.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: '大文件分块只读视图' })).toBeVisible();
  const chunkFirstScreenUpperBoundMs = performance.now() - chunkOpenStarted;
  const chunkProcessTree = await measureProcessTree(process.cwd(), processId);
  await expect(page.locator('.large-file-text')).toContainText('x');
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect((await menuItem(page, '另存为'))).toBeDisabled();
  const beforeLength = (await page.locator('.large-file-text').textContent())?.length ?? 0;
  expect(beforeLength).toBeLessThan(64 * 1024 + 16);
  await expect(page.getByRole('button', { name: '上一块' })).toBeDisabled();
  await page.getByRole('button', { name: '下一块' }).click();
  await expect(page.getByText(/第 2 页/)).toBeVisible();
  expect((await page.locator('.large-file-text').textContent())?.length ?? 0).toBeLessThan(64 * 1024 + 16);
  await page.getByRole('button', { name: '上一块' }).click();
  await expect(page.getByText(/第 1 页/)).toBeVisible();
  expect((await page.locator('.large-file-text').textContent())?.length ?? 0).toBe(beforeLength);
  expect(createHash('sha256').update(await readFile(chunkTarget)).digest('hex')).toBe(chunkHash);
  await page.screenshot({ path: path.join(evidence, 'native-release-large-chunk.png') });

  const headTarget = path.join(dataDir, '超大文件 100MiB加1😀.txt');
  const size = 100 * 1024 * 1024 + 1;
  const marker = 'HEAD-PREVIEW-中文😀';
  const buffer = Buffer.alloc(64 * 1024, 'y');
  const handle = await import('node:fs/promises').then(fs => fs.open(headTarget, 'w'));
  try {
    await handle.write(Buffer.from(marker, 'utf8'));
    const markerLength = Buffer.byteLength(marker);
    buffer.fill('y');
    let written = markerLength;
    while (written < size) {
      const length = Math.min(buffer.length, size - written);
      await handle.write(buffer, 0, length, written);
      written += length;
    }
  } finally { await handle.close(); }
  const headHash = createHash('sha256').update(await readFile(headTarget)).digest('hex');

  const headOpenStarted = performance.now();
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await openLargeFixture(headTarget, 'open-head-preview');
  await expect(page.getByText(/不会自动加载完整内容/)).toBeVisible();
  const previewActionStarted = performance.now();
  await page.getByRole('button', { name: '预览所选文件 1 的前1MiB' }).click();
  await expect(page.getByRole('region', { name: '大文件限量预览' })).toContainText(marker);
  const headPreviewActionMs = performance.now() - previewActionStarted;
  const headFirstScreenUpperBoundMs = performance.now() - headOpenStarted;
  const headProcessTree = await measureProcessTree(process.cwd(), processId);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect((await menuItem(page, '另存为'))).toBeDisabled();
  expect(createHash('sha256').update(await readFile(headTarget)).digest('hex')).toBe(headHash);
  await page.screenshot({ path: path.join(evidence, 'native-release-head-preview.png') });
  return {
    chunkFirstScreenUpperBoundMs,
    headFirstScreenUpperBoundMs,
    headPreviewActionMs,
    chunkProcessTree,
    headProcessTree,
    scope: 'single Win11 development run; includes controlled native chooser automation for upper-bound timings; not M5 p95 or target-machine evidence',
  };
}

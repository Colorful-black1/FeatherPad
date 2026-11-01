import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyNativeDegradedEditing(page: Page, dataDir: string,
  openDegraded: (target: string) => Promise<void>, evidence: string) {
  const target = path.join(dataDir, '降级 2MiB加1😀.txt');
  const original = Buffer.alloc(2 * 1024 * 1024 + 1, 'x');
  for (let index = 511; index < original.length; index += 512) original[index] = 10;
  original[original.length - 1] = 33;
  await writeFile(target, original);
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await openDegraded(target);
  await expect(page.getByRole('tab', { name: '降级 2MiB加1😀.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('纯文本 · 降级', { exact: true })).toBeVisible();
  await expect(page.getByText(/^已使用纯文本降级模式/)).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+Home');
  const inserted = '中文😀降级编辑';
  await page.keyboard.insertText(inserted);
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('未修改');
  expect(await readFile(target)).toEqual(Buffer.concat([Buffer.from(inserted, 'utf8'), original]));
  await page.screenshot({ path: path.join(evidence, 'native-release-degraded-editable.png') });
}

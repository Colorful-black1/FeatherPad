import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyNativeSaveAll(page: Page, dataDir: string, second: string, firstSave: string,
  chooseDestination: (action: 'save' | 'cancel', destination?: string) => Promise<void>, evidence: string) {
  // Move the first conflicted buffer to a fresh native destination before building the batch.
  await page.getByRole('tab', { name: /中文 fixture.txt/ }).click();
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  const alternate = path.join(dataDir, '批次 第一项😀.txt');
  await chooseDestination('save', alternate);
  await expect(page.getByRole('tab', { name: '批次 第一项😀.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  const originalFirst = await readFile(alternate, 'utf8');
  const originalSecond = await readFile(second, 'utf8');
  async function append(text: string) {
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(text);
  }
  await append(' 批次第一项');
  await page.getByRole('tab', { name: '第二份 emoji😀.txt', exact: true }).click();
  await append(' 批次第二项');
  await page.getByRole('tab', { name: '首次 保存😀.txt', exact: true }).click();
  await append(' 第三项冲突仍保留');
  const external = '第三项外部写入，批次不得覆盖😀';
  await writeFile(firstSave, external, 'utf8');
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('第四项取消路径后保留😀');
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('第五项不应处理😀');

  await page.getByRole('button', { name: '全部保存', exact: true }).click();
  await chooseDestination('cancel'); // Only the fourth (untitled) item needs a picker.
  const results = page.getByRole('region', { name: '全部保存', exact: true });
  await expect(results).toContainText('本次处理结束：已处理 4 / 5 份');
  const rows = results.getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute('data-save-result', 'saved');
  await expect(rows.nth(1)).toHaveAttribute('data-save-result', 'saved');
  await expect(rows.nth(2)).toHaveAttribute('data-save-result', 'failed');
  await expect(rows.nth(2)).toContainText('磁盘文件已变化');
  await expect(rows.nth(3)).toHaveAttribute('data-save-result', 'cancelled');
  await expect(rows.nth(4)).toHaveAttribute('data-save-result', 'unprocessed');
  await expect(results).toContainText('当前仍有 3 份未保存修改');
  expect(await readFile(alternate, 'utf8')).toBe(`${originalFirst} 批次第一项`);
  expect(await readFile(second, 'utf8')).toBe(`${originalSecond} 批次第二项`);
  expect(await readFile(firstSave, 'utf8')).toBe(external);
  await expect(page.getByRole('tab', { name: '批次 第一项😀.txt', exact: true })).not.toContainText('●');
  await expect(page.getByRole('tab', { name: '第二份 emoji😀.txt', exact: true })).not.toContainText('●');
  for (const title of ['首次 保存😀.txt', '无标题 2', '无标题 3']) {
    await expect(page.getByRole('tab', { name: new RegExp(title) })).toContainText('●');
  }
  await results.getByRole('button', { name: '首次 保存😀.txt', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('第三项冲突仍保留');
  await page.getByRole('tab', { name: /无标题 2/ }).click();
  await expect(page.locator('.cm-content')).toHaveText('第四项取消路径后保留😀');
  await page.getByRole('tab', { name: /无标题 3/ }).click();
  await expect(page.locator('.cm-content')).toHaveText('第五项不应处理😀');
  await page.screenshot({ path: path.join(evidence, 'native-release-save-all.png') });
}

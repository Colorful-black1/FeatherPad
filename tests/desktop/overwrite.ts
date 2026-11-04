import { menuItem } from '../ui-actions';
import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type OverwriteAction = 'overwrite' | 'confirm-system' | 'inspect-overwrite' | 'confirm-overwrite' | 'reject-overwrite';

export async function verifyNativeOverwrite(page: Page, dataDir: string, second: string,
  nativeAction: (action: OverwriteAction, destination: string) => Promise<void>, evidence: string) {
  const destination = path.join(dataDir, '已有 目标😀.txt');
  const original = '已有目标的原内容😀';
  await writeFile(destination, original, 'utf8');
  const draft = '第五项不应处理😀'; // The active, still-dirty draft after the save-all scenario.
  await expect(page.locator('.cm-content')).toHaveText(draft);
  const originalTabId = await page.getByRole('tab', { name: /无标题 3/ }).getAttribute('id');

  async function beginOverwrite() {
    await (await menuItem(page, '另存为')).click();
    await nativeAction('overwrite', destination);
    await nativeAction('confirm-system', destination);
    await nativeAction('inspect-overwrite', destination);
  }
  await beginOverwrite();
  await nativeAction('reject-overwrite', destination);
  await expect((await menuItem(page, '另存为'))).toBeEnabled();
  await expect(page.getByRole('tab', { name: /无标题 3/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  expect(await readFile(destination, 'utf8')).toBe(original);
  await expect(page.locator('.cm-content')).toHaveText(draft);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await beginOverwrite();
  const external = '确认期间的外部修改必须保留😀';
  await writeFile(destination, external, 'utf8');
  await nativeAction('confirm-overwrite', destination);
  await expect(page.getByRole('alert')).toContainText('磁盘文件已变化');
  expect(await readFile(destination, 'utf8')).toBe(external);
  await expect(page.getByRole('tab', { name: /无标题 3/ })).toContainText('●');
  await expect(page.locator('.cm-content')).toHaveText(draft);

  await beginOverwrite();
  await nativeAction('confirm-overwrite', destination);
  await expect(page.getByRole('tab', { name: '已有 目标😀.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '已有 目标😀.txt', exact: true })).toHaveAttribute('id', originalTabId!);
  await expect(page.getByRole('status')).toContainText('未修改');
  expect(await readFile(destination, 'utf8')).toBe(draft);
  await expect(page.locator('.cm-content')).toHaveText(draft);

  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 覆盖副本的新内容');
  await (await menuItem(page, '保存副本')).click();
  await nativeAction('overwrite', destination);
  await nativeAction('confirm-system', destination);
  await expect(page.getByRole('alert')).toContainText('保存副本必须选择与源文档不同的文件');
  expect(await readFile(destination, 'utf8')).toBe(draft);
  const copy = path.join(dataDir, '已有 副本目标😀.txt');
  await writeFile(copy, '副本目标的受控原内容', 'utf8');
  await (await menuItem(page, '保存副本')).click();
  await nativeAction('overwrite', copy);
  await nativeAction('confirm-system', copy);
  await nativeAction('inspect-overwrite', copy);
  await nativeAction('confirm-overwrite', copy);
  await expect(page.getByText(`副本已保存：${copy}`, { exact: true })).toBeVisible();
  expect(await readFile(copy, 'utf8')).toBe(`${draft} 覆盖副本的新内容`);
  expect(await readFile(destination, 'utf8')).toBe(draft);
  await expect(page.getByRole('tab', { name: /已有 目标😀.txt/ })).toHaveAttribute('id', originalTabId!);
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.locator('.cm-content')).toHaveText(`${draft} 覆盖副本的新内容`);
  await page.screenshot({ path: path.join(evidence, 'native-release-overwrite-copy.png') });

  const secondBefore = await readFile(second, 'utf8');
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('不能覆盖另一打开文档😀');
  await (await menuItem(page, '另存为')).click();
  await nativeAction('overwrite', second);
  await nativeAction('confirm-system', second);
  await expect(page.getByRole('alert')).toContainText('目标已由另一个打开的文档占用');
  expect(await readFile(second, 'utf8')).toBe(secondBefore);
  await expect(page.getByRole('tab', { name: /无标题 4/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.locator('.cm-content')).toHaveText('不能覆盖另一打开文档😀');
  await page.screenshot({ path: path.join(evidence, 'native-release-overwrite-collision.png') });
}

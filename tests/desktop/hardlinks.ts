import { expect, type Page } from '@playwright/test';
import { link, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type HardlinkAction = 'open' | 'inspect-hardlink' | 'confirm-hardlink' | 'reject-hardlink';

export async function verifyNativeHardlinks(page: Page, dataDir: string,
  nativeAction: (action: HardlinkAction, target: string) => Promise<void>, evidence: string) {
  const selected = path.join(dataDir, '硬链接 原路径😀.txt');
  const alias = path.join(dataDir, '硬链接 别名😀.txt');
  const original = '硬链接受控原文😀';
  await writeFile(selected, original, 'utf8');
  await link(selected, alias);
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await nativeAction('open', selected);
  const selectedTab = page.getByRole('tab', { name: /硬链接 原路径😀.txt/ });
  await expect(selectedTab).toHaveAttribute('aria-selected', 'true');
  const tabId = await selectedTab.getAttribute('id');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 只保存所选路径');
  await page.keyboard.press('Control+s');
  await nativeAction('inspect-hardlink', selected);
  if (!tabId?.startsWith('tab-')) throw new Error('Native document identity missing');
  const concurrent = await page.evaluate(async documentId => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    const stat = await native.invoke('stat_document', { documentId }) as { ok: boolean; value: { diskRevision: string } };
    if (!stat.ok) throw new Error('Native stat should remain available during consent');
    const save = await native.invoke('save_document', { documentId, requestId: crypto.randomUUID(), documentVersion: 1,
      expectedDiskRevision: stat.value.diskRevision, text: 'Controlled concurrent save must not write',
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' } });
    return { stat, save };
  }, tabId.slice(4));
  expect(concurrent.stat).toMatchObject({ ok: true });
  expect(concurrent.save).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(await readFile(selected, 'utf8')).toBe(original);
  expect(await readFile(alias, 'utf8')).toBe(original);
  await nativeAction('reject-hardlink', selected);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveText(`${original} 只保存所选路径`);
  expect(await readFile(selected, 'utf8')).toBe(original);
  expect(await readFile(alias, 'utf8')).toBe(original);

  await page.keyboard.press('Control+s');
  await nativeAction('confirm-hardlink', selected);
  await expect(page.getByRole('status')).toContainText('未修改');
  await expect(selectedTab).toHaveAttribute('id', tabId!);
  expect(await readFile(selected, 'utf8')).toBe(`${original} 只保存所选路径`);
  expect(await readFile(alias, 'utf8')).toBe(original);
  await page.screenshot({ path: path.join(evidence, 'native-release-hardlink-saved.png') });

  const secondAlias = path.join(dataDir, '硬链接 外改别名😀.txt');
  await link(alias, secondAlias);
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await nativeAction('open', alias);
  const aliasTab = page.getByRole('tab', { name: /硬链接 别名😀.txt/ });
  await expect(aliasTab).toHaveAttribute('aria-selected', 'true');
  expect(await aliasTab.getAttribute('id')).not.toBe(tabId);
  await expect(page.locator('.cm-content')).toHaveText(original);
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 确认期间冲突输入保留');
  await page.keyboard.press('Control+s');
  await nativeAction('inspect-hardlink', alias);
  const external = '硬链接确认期间真实外部改写😀';
  await writeFile(alias, external, 'utf8');
  await nativeAction('confirm-hardlink', alias);
  await expect(page.getByRole('alert')).toContainText('磁盘文件已变化');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.locator('.cm-content')).toHaveText(`${original} 确认期间冲突输入保留`);
  expect(await readFile(alias, 'utf8')).toBe(external);
  expect(await readFile(secondAlias, 'utf8')).toBe(external);
  expect(await readFile(selected, 'utf8')).toBe(`${original} 只保存所选路径`);
  await page.screenshot({ path: path.join(evidence, 'native-release-hardlink-conflict.png') });
}

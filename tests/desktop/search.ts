import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

type OpenFile = (target: string) => Promise<void>;

export async function verifyNativeSearch(page: Page, dataDir: string, openFile: OpenFile, evidence: string) {
  const readonly = path.join(dataDir, 'T108 read-only search.txt');
  await writeFile(readonly, 'FeatherPad feather', 'utf8');
  await runFile('attrib.exe', ['+R', readonly], { windowsHide: true });
  try {
    await page.getByRole('button', { name: '新建文本', exact: true }).click();
    const editor = page.locator('.cm-content');
    await editor.focus();
    await page.keyboard.insertText('cat scatter CAT 2 dog 3');
    await page.keyboard.press('Control+f');
    const findBar = page.locator('.find-bar');
    await expect(findBar).toBeVisible();
    const query = findBar.getByRole('textbox', { name: '查找内容' });
    await query.fill('cat');
    await expect(findBar.locator('.find-result')).toContainText('3 处');
    await findBar.getByRole('checkbox', { name: '区分大小写' }).check();
    await expect(findBar.locator('.find-result')).toContainText('2 处');
    await findBar.getByRole('checkbox', { name: '整词' }).check();
    await expect(findBar.locator('.find-result')).toContainText('1 处');
    await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
    await findBar.getByRole('button', { name: '下一个匹配' }).click();
    await expect(findBar).toContainText('已环绕到第一处匹配');

    await findBar.getByRole('checkbox', { name: '区分大小写' }).uncheck();
    await findBar.getByRole('checkbox', { name: '整词' }).uncheck();
    await findBar.getByRole('checkbox', { name: '安全正则' }).check();
    await query.fill('(?=cat)');
    await expect(findBar.getByRole('alert')).toContainText('不支持前后查找');
    await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
    await query.fill('(\\p{L}+) (\\d+)');
    await expect(findBar.locator('.find-result')).toContainText('2 处');
    await findBar.getByRole('textbox', { name: '替换内容' }).fill('$2:$1');
    await findBar.getByRole('button', { name: /全部替换/ }).click();
    await expect(editor).toHaveText('cat scatter 2:CAT 3:dog');
    await expect(findBar).toContainText('已在一次编辑中替换 2 处');
    await editor.focus();
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('cat scatter CAT 2 dog 3');

    await findBar.getByRole('button', { name: '关闭查找' }).click();
    await editor.focus();
    await page.keyboard.press('Control+Home');
    for (let index = 0; index < 12; index++) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+f');
    await findBar.getByRole('checkbox', { name: '安全正则' }).uncheck();
    await query.fill('cat');
    await expect(findBar).toContainText('查找范围：当前选区');
    await expect(findBar.locator('.find-result')).toContainText('1 处');
    await findBar.getByRole('textbox', { name: '替换内容' }).fill('dog');
    await findBar.getByRole('button', { name: '替换当前' }).click();
    await expect(editor).toHaveText('cat scatter dog 2 dog 3');
    await expect(findBar).toContainText('文档已变化，查找范围已安全重置为全文');
    await page.screenshot({ path: path.join(evidence, 'native-search-editable.png') });

    await findBar.getByRole('button', { name: '关闭查找' }).click();
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    await openFile(readonly);
    await expect(page.getByRole('tab', { name: 'T108 read-only search.txt', exact: true })).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await page.keyboard.press('Control+f');
    await query.fill('feather');
    await expect(findBar.locator('.find-result')).toContainText('2 处');
    await expect(findBar.getByRole('textbox', { name: '替换内容' })).toBeDisabled();
    await expect(findBar.getByRole('button', { name: '替换当前' })).toBeDisabled();
    await expect(findBar.getByRole('button', { name: /全部替换/ })).toBeDisabled();
    await expect(findBar).toContainText('只读文档仅支持查找');
    await page.screenshot({ path: path.join(evidence, 'native-search-readonly.png') });
    await findBar.getByRole('button', { name: '关闭查找' }).click();

    return {
      nativeSearchVerified: true,
      unicodeAndCaseVerified: true,
      wholeWordVerified: true,
      navigationAndWrapVerified: true,
      invalidRegexPositionVerified: true,
      captureReplacementVerified: true,
      replaceAllSingleUndoVerified: true,
      selectionScopeVerified: true,
      readonlySearchOnlyVerified: true,
      readonlyFixtureSha256: createHash('sha256').update(await readFile(readonly)).digest('hex'),
      scope: 'real Tauri Release WebView2 with native file attributes and OS chooser; search engine runs in the bundled local worker',
    };
  } finally {
    await runFile('attrib.exe', ['-R', readonly], { windowsHide: true }).catch(() => undefined);
    await unlink(readonly).catch(() => undefined);
  }
}

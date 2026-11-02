import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { languageLabel, type LanguageId } from '../../src/features/editor/editor-language';

type Choose = (action: 'open-folder' | 'save' | 'cancel', target?: string) => Promise<void>;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyNativeMvp(page: Page, dataDir: string, evidence: string, choose: Choose) {
  const editor = page.locator('.cm-content');
  const status = page.getByRole('status', { name: '应用状态', exact: true });
  const draft = 'G1 无标题中文😀，取消保存仍保留正文';
  await page.keyboard.press('Control+n');
  await editor.focus();
  await page.keyboard.insertText(draft);
  await page.keyboard.press('Control+s');
  await choose('cancel');
  await expect(editor).toHaveText(draft);
  await expect(status).toContainText('未保存修改');
  const savedDraft = path.join(dataDir, '首次 保存中文😀.txt');
  await editor.focus();
  await page.keyboard.press('Control+s');
  await choose('save', savedDraft);
  await expect(status).toContainText('未修改');
  expect(await readFile(savedDraft, 'utf8')).toBe(draft);

  const root = path.join(dataDir, 'G1 中文工作区');
  const nested = path.join(root, '一级 目录', '二级😀');
  await mkdir(nested, { recursive: true });
  const fixtures: { name: string; language: LanguageId; body: string }[] = [
    { name: '中文 文档.md', language: 'markdown', body: '# 中文😀\r\n正文' },
    { name: '中文 Main.java', language: 'java', body: 'public class Main {}\r\n// 中文😀' },
    { name: '中文 配置.json', language: 'json', body: '{\r\n  "text": "中文😀"\r\n}' },
    { name: '中文 查询.sql', language: 'sql', body: "SELECT '中文😀';\r\n-- 第二行" },
    { name: '中文 结构.xml', language: 'xml', body: '<root>中文😀</root>' },
    { name: '中文 页面.html', language: 'html', body: '<p>中文😀</p>' },
    { name: '中文 文本.txt', language: 'plaintext', body: '中文😀\r\n第二行' },
  ];
  await Promise.all(fixtures.map(fixture => writeFile(path.join(nested, fixture.name), fixture.body, 'utf8')));
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await choose('open-folder', root);
  const tree = page.getByRole('tree', { name: 'G1 中文工作区 文件树', exact: true });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: fixtures[0]!.name, exact: true })).toHaveCount(0);
  await tree.getByRole('treeitem', { name: '一级 目录', exact: true }).click();
  await tree.getByRole('treeitem', { name: '二级😀', exact: true }).click();

  const results = [];
  const suffix = ' G1 编辑中文😀';
  for (const fixture of fixtures) {
    const file = path.join(nested, fixture.name);
    await tree.getByRole('treeitem', { name: fixture.name, exact: true }).click();
    await expect(page.locator('.cm-line')).toHaveText(fixture.body.split('\r\n'));
    const language = page.getByRole('combobox', { name: '语言模式', exact: true });
    await expect(language).toHaveValue('auto');
    await expect(language.locator('option:checked')).toHaveText(`自动（${languageLabel(fixture.language)}）`);
    await expect(status).toContainText(languageLabel(fixture.language));
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(suffix);
    const tab = page.getByRole('tab', { name: `${fixture.name} 有未保存修改`, exact: true });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-description', '固定标签；有未保存修改');
    const documentId = await tab.getAttribute('id');
    await page.keyboard.press('Control+s');
    await expect(status).toContainText('未修改');
    const expected = `${fixture.body}${suffix}`;
    expect(await readFile(file, 'utf8')).toBe(expected);
    // Saving must retain per-document undo, and undoing a saved edit must become dirty.
    await editor.focus();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-line')).toHaveText(fixture.body.split('\r\n'));
    await expect(status).toContainText('未保存修改');
    expect(await readFile(file, 'utf8')).toBe(expected);
    await page.keyboard.press('Control+y');
    await expect(status).toContainText('未修改');
    results.push({ name: fixture.name, language: fixture.language, documentId, savedSha256: sha256(await readFile(file)) });
  }
  await expect(page.getByRole('tab')).toHaveCount(8);
  // Return to an earlier document, preserving its own undo after editing all seven types.
  const first = results[0]!;
  await page.locator(`[id="${first.documentId}"]`).click();
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(fixtures[0]!.body.split('\r\n'));
  await page.keyboard.press('Control+y');
  await expect(page.locator('.cm-line')).toHaveText(`${fixtures[0]!.body}${suffix}`.split('\r\n'));
  await expect(status).toContainText('未修改');
  for (const result of results) {
    expect(sha256(await readFile(path.join(nested, result.name)))).toBe(result.savedSha256);
  }
  await page.screenshot({ path: path.join(evidence, 'native-mvp-seven-types.png') });
  return {
    scope: 'Real offline Release UI, native folder/save/cancel choosers, actual source bytes; no business mocks',
    untitledCancelPreservesDraftAndFirstSaveBytes: true,
    twoLevelLazyTreeAndSevenFileTypes: true,
    languageDetectionSaveBytesAndUndoAcrossTabs: true,
    savedDraftSha256: sha256(await readFile(savedDraft)),
    files: results,
  };
}

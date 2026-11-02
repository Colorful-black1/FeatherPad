import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const commandDialog = (page: Page) => page.getByRole('dialog', { name: '命令面板', exact: true });
const commandQuery = (page: Page) => commandDialog(page).getByRole('combobox', { name: '搜索命令', exact: true });
const quickDialog = (page: Page) => page.getByRole('dialog', { name: '快速打开', exact: true });
const quickQuery = (page: Page) => quickDialog(page).getByRole('combobox', { name: '搜索文件', exact: true });
const editor = (page: Page) => page.locator('.cm-content');

export async function verifyNativeCommands(page: Page, dataDir: string, evidence: string, chooseFolder: (target: string) => Promise<void>) {
  const root = path.join(dataDir, 'T109 命令入口😀');
  await mkdir(path.join(root, 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'beta'));
  const source = path.join(root, 'source.txt');
  const readOnly = path.join(root, 'locked.txt');
  const original = '原生命令正文😀';
  const expected = `${original} 保存修改`;
  await writeFile(source, original, 'utf8');
  await writeFile(path.join(root, 'alpha', 'note.txt'), '甲目录正文😀', 'utf8');
  await writeFile(path.join(root, 'beta', 'note.txt'), '乙目录正文😀', 'utf8');
  await writeFile(readOnly, '只读原件不能覆盖😀', 'utf8');
  const readOnlyHash = createHash('sha256').update(await readFile(readOnly)).digest('hex');
  await runFile('attrib.exe', ['+R', readOnly], { windowsHide: true });
  try {
    await page.keyboard.press('Control+Shift+p');
    await expect(commandQuery(page)).toBeFocused();
    await commandQuery(page).fill('folder workspace');
    await commandQuery(page).press('Enter');
    await chooseFolder(root);
    await expect(page.getByRole('treeitem', { name: 'source.txt', exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await quickQuery(page).fill('source.txt');
    await quickQuery(page).press('Enter');
    await expect(editor(page)).toHaveText(original);
    const sourceId = await page.getByRole('tab', { name: 'source.txt', exact: true }).getAttribute('id');
    await editor(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' 保存修改');
    await page.keyboard.press('Control+p');
    await quickQuery(page).fill('source.txt');
    await expect(quickDialog(page).getByRole('option')).toHaveCount(1);
    await quickQuery(page).press('Enter');
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /source\.txt/ })).toHaveAttribute('id', sourceId ?? 'missing');
    await expect(editor(page)).toHaveText(expected);

    await page.keyboard.press('Control+Shift+p');
    await commandQuery(page).fill('save write');
    await commandQuery(page).press('Enter');
    await expect(page.getByRole('status')).toContainText('未修改');
    expect(await readFile(source, 'utf8')).toBe(expected);

    await page.keyboard.press('Control+Shift+p');
    await commandQuery(page).fill('command palette');
    await commandDialog(page).getByRole('button', { name: '修改快捷键', exact: true }).click();
    const binding = commandDialog(page).getByRole('textbox', { name: '快捷键组合', exact: true });
    await binding.fill('Ctrl+S');
    await commandDialog(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
    await expect(commandDialog(page).getByRole('alert')).toContainText('已用于“保存”');
    await binding.fill('Ctrl+Shift+K');
    await commandDialog(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
    await expect(commandDialog(page).getByRole('alert')).toContainText('保留给原生文本编辑');
    await binding.press('Control+Shift+l');
    await commandDialog(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Control+Shift+l'); // Must work from CodeMirror, not only a welcome-page button.
    await expect(commandQuery(page)).toBeFocused();
    const tabCount = await page.getByRole('tab', { includeHidden: true }).count();
    await page.keyboard.press('Control+n');
    expect(await page.getByRole('tab', { includeHidden: true }).count()).toBe(tabCount);
    await commandQuery(page).fill('theme dark');
    await commandQuery(page).press('Enter');
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveText(expected);
    await page.keyboard.press('Control+z');
    await expect(editor(page)).toHaveText(original);
    await expect(page.getByRole('status')).toContainText('未保存修改');
    await page.keyboard.press('Control+y');
    await expect(editor(page)).toHaveText(expected);
    await expect(page.getByRole('status')).toContainText('未修改');

    await page.keyboard.press('Control+Shift+l');
    await commandQuery(page).fill('quick open');
    await commandDialog(page).getByRole('button', { name: '修改快捷键', exact: true }).click();
    await binding.press('F8');
    await commandDialog(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('F8');
    await quickQuery(page).fill('note.txt');
    await expect(quickDialog(page).getByRole('option')).toHaveCount(0);
    await quickQuery(page).press('Enter');
    await expect(quickDialog(page).getByRole('alert')).toContainText('没有可执行的结果');
    await page.keyboard.press('Escape');
    await page.getByRole('treeitem', { name: 'alpha', exact: true }).click();
    await page.getByRole('treeitem', { name: 'beta', exact: true }).click();
    await page.keyboard.press('F8');
    await quickQuery(page).fill('note.txt');
    const options = quickDialog(page).getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('alpha/note.txt');
    await expect(options.nth(1)).toContainText('beta/note.txt');
    await quickQuery(page).press('ArrowUp');
    await quickQuery(page).press('Enter');
    await expect(editor(page)).toHaveText('乙目录正文😀');
    expect(await readFile(path.join(root, 'beta', 'note.txt'), 'utf8')).toBe('乙目录正文😀');

    await page.keyboard.press('F8');
    await quickQuery(page).fill('locked.txt');
    await quickQuery(page).press('Enter');
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
    await editor(page).focus();
    await page.keyboard.press('Control+Shift+l');
    await commandQuery(page).fill('save write');
    await expect(commandDialog(page).getByRole('option')).toHaveAttribute('aria-disabled', 'true');
    await commandQuery(page).press('Enter');
    await expect(commandDialog(page).getByRole('alert')).toContainText('只读');
    expect(createHash('sha256').update(await readFile(readOnly)).digest('hex')).toBe(readOnlyHash);
    await page.screenshot({ path: path.join(evidence, 'native-command-disabled.png') });
    await page.keyboard.press('Escape');
    await page.reload(); // Every retained buffer is clean; only shortcut metadata is under test.
    await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    await page.keyboard.press('Control+Shift+l');
    await expect(commandQuery(page)).toBeFocused();
    await commandQuery(page).fill('quick open');
    await expect(commandDialog(page).getByRole('option')).toContainText('F8');
    await commandDialog(page).getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+p');
    await expect(commandQuery(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await expect(quickQuery(page)).toBeFocused();
    await page.keyboard.press('Escape');
    return { nativeCommandsOpenOwnedFolderAndFile: true, nativeQuickOpenReusesDirtyDocument: true,
      nativeCommandSaveBytesVerified: true, nativeRemappingFromEditorAndConflictChecks: true,
      nativeModalIsolationAndEditorUndo: true, nativeLoadedCandidatesAndSameNamePaths: true,
      nativeReadonlyCommandDeniedAndSourceUnchanged: true, nativeBindingPreferencesReloadAndReset: true,
      savedSha256: createHash('sha256').update(await readFile(source)).digest('hex'), readOnlySha256: readOnlyHash,
      scope: 'Real Release, native chooser, file bytes and WebView2 keyboard/CM focus; renderer reload tests shortcut metadata, not full startup recovery or OS scale' };
  } finally {
    await runFile('attrib.exe', ['-R', readOnly], { windowsHide: true });
  }
}

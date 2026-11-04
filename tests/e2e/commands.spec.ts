import { menuItem } from '../ui-actions';
import { expect, test, type Page } from './test-fixture';
import { readFile } from 'node:fs/promises';

const palette = (page: Page) => page.getByRole('dialog', { name: '命令面板', exact: true });
const query = (page: Page) => palette(page).getByRole('combobox', { name: '搜索命令', exact: true });

test('command palette exposes disabled reasons and never executes a stale result after filtering to empty', async ({ page }) => {
  await page.goto('/');
  const origin = page.getByRole('button', { name: /^命令面板/ });
  await origin.click();
  await expect(query(page)).toBeFocused();
  await query(page).fill('save write');
  await expect(palette(page).getByRole('option')).toHaveCount(1);
  await expect(palette(page).getByRole('option')).toHaveAttribute('aria-disabled', 'true');
  await expect(palette(page).getByRole('option')).toContainText('请先打开或新建文档');
  await query(page).press('Enter');
  await expect(palette(page).getByRole('alert')).toContainText('请先打开');
  await query(page).fill('不存在的受控命令');
  await query(page).press('Enter');
  await expect(palette(page).getByRole('option')).toHaveCount(0);
  await expect(palette(page).getByRole('alert')).toHaveText('没有可执行的结果。');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(origin).toBeFocused();
});

test('commands and shortcuts share actions, loop selection and restore the editor focus and undo', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('命令前保留正文😀');
  const editor = page.locator('.cm-content');
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.keyboard.press('Control+Shift+p');
  await query(page).fill('theme dark');
  const option = palette(page).getByRole('option');
  await expect(option).toHaveCount(1);
  await query(page).press('ArrowDown');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await query(page).press('ArrowUp');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await query(page).press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme ?? '');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('命令前保留正文😀');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
});

test('shortcut editing rejects conflicts and reserved keys, persists valid changes and resets defaults', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+p');
  await query(page).fill('command palette');
  await palette(page).getByRole('button', { name: '修改快捷键', exact: true }).click();
  const binding = palette(page).getByRole('textbox', { name: '快捷键组合', exact: true });
  await binding.fill('Ctrl+S');
  await palette(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
  await expect(palette(page).getByRole('alert')).toContainText('已用于“保存”');
  await binding.fill('Ctrl+C');
  await palette(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
  await expect(palette(page).getByRole('alert')).toContainText('保留给原生文本编辑');
  await binding.fill('Ctrl+Shift+K');
  await palette(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
  await expect(palette(page).getByRole('alert')).toContainText('保留给原生文本编辑');
  await binding.press('Shift+Alt+O');
  await expect(binding).toHaveValue('Shift+Alt+O');
  await palette(page).getByRole('button', { name: '应用快捷键', exact: true }).click();
  await expect(palette(page).getByRole('option')).toContainText('Shift+Alt+O');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('Shift+Alt+O');
  await expect(query(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.keyboard.press('Shift+Alt+O');
  await expect(query(page)).toBeFocused();
  await palette(page).getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+p');
  await expect(query(page)).toBeFocused();
});

test('remapped editor shortcuts execute inside CodeMirror and complete shortcut files import atomically', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+n');
  const editor = page.locator('.cm-content');
  await page.keyboard.insertText('same other same\nline');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Shift+p');
  await query(page).fill('select all occurrences');
  await palette(page).getByRole('button', { name: '修改快捷键', exact: true }).click();
  const binding = palette(page).getByRole('textbox', { name: '快捷键组合', exact: true });
  await binding.fill('Shift+Alt+O');
  await palette(page).getByRole('button', { name: '应用快捷键', exact: true }).click();

  const downloadPromise = page.waitForEvent('download');
  await palette(page).getByRole('button', { name: '导出快捷键…', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = JSON.parse(await readFile(path!, 'utf8')) as {
    schemaVersion: number; bindings: [string, string | null][];
  };
  const commandPalette = exported.bindings.find(([id]) => id === 'commands.open');
  expect(commandPalette?.[1]).toBe('Ctrl+Shift+P');
  commandPalette![1] = 'Shift+Alt+U';
  await palette(page).getByLabel('导入快捷键文件').setInputFiles({
    name: 'shortcuts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(palette(page).getByRole('alert')).toContainText('已导入');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Shift+Alt+O');
  await page.keyboard.insertText('X');
  await expect(editor).toHaveText('X other Xline');
  await page.keyboard.press('Shift+Alt+U');
  await expect(query(page)).toBeFocused();
});

test('modal and composition input do not run background commands and editing remains visible at 200 percent', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await query(page).fill('command palette');
  await palette(page).getByRole('button', { name: '修改快捷键', exact: true }).click();
  for (const button of await palette(page).getByRole('button').all()) await expect(button).toBeInViewport();
  await expect(palette(page).getByRole('textbox', { name: '快捷键组合', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('palette-bindings-zoom200.png') });
  await page.keyboard.press('Escape');
  await expect(query(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('Web mock: quick open uses loaded authorized candidates, distinguishes paths and preserves dirty open buffers', async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    Reflect.set(window, 'quickOpened', opened);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: { ref?: { grantId: string; relativePath: string } }) => {
      const ref = args.ref ?? { grantId: 'quick-root', relativePath: '' };
      if (command === 'choose_folder') return { ok: true, value: { grant: ref, displayName: 'quick-root' } };
      if (command === 'inspect_workspace_root') return { ok: true, value: { ref, displayName: 'quick-root', displayPath: 'E:/quick-root', canonicalIdentity: 'c'.repeat(64) } };
      if (command === 'list_directory') return { ok: true, value: { items: (ref.relativePath ? ['note.txt'] : ['alpha', 'beta', 'root.txt']).map(name => ({
        id: `${ref.relativePath}/${name}`, name, ref: { ...ref, relativePath: ref.relativePath ? `${ref.relativePath}/${name}` : name },
        kind: name.includes('.') ? 'file' : 'directory', isHidden: false, isReadOnly: false, revision: 'a'.repeat(64),
      })), nextCursor: null } };
      if (command === 'open_document') {
        opened.push(ref.relativePath);
        return { ok: true, value: { documentId: ref.relativePath, ref,
          metadata: { displayPath: `E:/quick/${ref.relativePath}`, sizeBytes: 10, modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false, diskRevision: 'a'.repeat(64) },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
          content: { kind: 'text', text: `原文 ${ref.relativePath}`, newlineMap: { documentVersion: 0, endings: [] } } } };
      }
      throw new Error('Unexpected quick-open test command');
    } });
  });
  await page.goto('/');
  await (await menuItem(page, '打开文件夹')).click();
  await page.getByRole('treeitem', { name: 'root.txt', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 保留修改');
  const quick = page.getByRole('dialog', { name: '快速打开', exact: true });
  const search = quick.getByRole('combobox', { name: '搜索文件', exact: true });
  await page.keyboard.press('Control+p');
  await expect(search).toBeFocused();
  await search.fill('root.txt');
  await expect(quick.getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  expect(await page.evaluate(() => Reflect.get(window, 'quickOpened'))).toEqual(['root.txt']);
  await expect(page.locator('.cm-content')).toHaveText('原文 root.txt 保留修改');
  await page.keyboard.press('Control+p');
  await search.fill('note.txt');
  await expect(quick.getByRole('option')).toHaveCount(0);
  await search.press('Enter');
  await expect(quick.getByRole('alert')).toHaveText('没有可执行的结果。');
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: 'alpha', exact: true }).click();
  await page.getByRole('treeitem', { name: 'beta', exact: true }).click();
  await page.keyboard.press('Control+p');
  await search.fill('note.txt');
  const options = quick.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('alpha/note.txt');
  await expect(options.nth(1)).toContainText('beta/note.txt');
  await search.press('ArrowUp');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await search.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await search.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await options.nth(1).click();
  await expect(quick).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'quickOpened'))).toEqual(['root.txt', 'beta/note.txt']);
  await expect(page.locator('.cm-content')).toHaveText('原文 beta/note.txt');
  await page.getByRole('tab', { name: /root\.txt/ }).click();
  await expect(page.locator('.cm-content')).toHaveText('原文 root.txt 保留修改');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-content')).toHaveText('原文 root.txt');
});

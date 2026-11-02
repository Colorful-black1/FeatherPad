import { expect, test } from '@playwright/test';

test('Web CodeMirror: status, selection, deletion and per-document undo stay local', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText('alpha\nbeta');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('status')).toContainText('0 字符');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('alphabeta');
  const status = page.getByRole('status');
  await editor.focus();
  await page.keyboard.press('Control+y');
  await expect(status).toContainText('0 字符');
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('alphabeta');
  await editor.focus();
  await page.keyboard.press('Control+a');
  await expect(status).toContainText('已选 10 字符');
  await page.keyboard.press('Control+Home');
  await expect(status).toContainText('行 1，列 1');
  await page.keyboard.press('Control+ArrowRight');
  await expect(status).toContainText('行 1，列 6');
});

test('Web CodeMirror: copy, cut and system clipboard keep text synchronized', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  const status = page.getByRole('status');
  await editor.focus();
  await page.keyboard.insertText('alpha\nbeta');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha\nbeta');
  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+x');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha\nbeta');
  await expect(status).toContainText('0 字符');
});

test('Web CodeMirror: Tab, ShiftTab and 2/4/8 settings edit mixed lines as single undo steps', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.insertText('one\n  two');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cm-line')).toHaveText(['    one', '      two']);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(['one', '  two']);
  await page.getByRole('combobox', { name: '缩进宽度' }).selectOption('2');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cm-line')).toHaveText(['  one', '    two']);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.cm-line')).toHaveText(['one', '  two']);
  await page.getByRole('combobox', { name: '缩进宽度' }).selectOption('8');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cm-line')).toHaveText(['        one', '          two']);
});

test('Web CodeMirror: language highlighting, bracket pairing and independent feature toggles', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('java');
  await editor.click();
  await page.keyboard.insertText('public class Main ');
  await page.keyboard.type('{');
  const publicToken = editor.locator('span').filter({ hasText: 'public' }).first();
  await expect(publicToken).toBeVisible();
  expect(await publicToken.evaluate(element => getComputedStyle(element).color))
    .not.toBe(await editor.evaluate(element => getComputedStyle(element).color));
  await expect(editor).toHaveText('public class Main {}');
  await expect(page.locator('.cm-matchingBracket')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(editor).toHaveText('public class Main ');
  await page.getByRole('checkbox', { name: '自动配对' }).uncheck();
  await page.keyboard.insertText('(');
  await expect(editor).toHaveText('public class Main (');
  await page.getByRole('checkbox', { name: '匹配括号' }).uncheck();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.getByRole('checkbox', { name: '自动配对' }).check();
  await page.keyboard.type('[');
  await expect(editor).toHaveText('[]');
  await expect(page.getByRole('combobox', { name: '语言模式' })).toHaveValue('java');
  await expect(page.getByRole('status')).toContainText('Java（手动）');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '语言模式' })).toHaveValue('auto');
  await page.getByRole('tab', { name: /无标题 1/ }).click();
  await expect(page.getByRole('combobox', { name: '语言模式' })).toHaveValue('java');
  await page.screenshot({ path: test.info().outputPath('editor-web.png') });
});

test('Web Chromium composition input inserts CJK once without duplicate bracket pairs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', {
    text: 'zhong', selectionStart: 5, selectionEnd: 5, replacementStart: 0, replacementEnd: 0,
  });
  await session.send('Input.imeSetComposition', {
    text: '中文', selectionStart: 2, selectionEnd: 2, replacementStart: 0, replacementEnd: 5,
  });
  await session.send('Input.insertText', { text: '中文' });
  await expect(editor).toHaveText('中文');
  await page.keyboard.insertText('(');
  await expect(editor).toHaveText('中文()');
});

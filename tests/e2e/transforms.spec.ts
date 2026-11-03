import { expect, test } from './test-fixture';

test('text tools preview the exact main selection, sort naturally and undo once without changing outer lines', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  const source = '外部\nb2\nb10\nb1\n尾部';
  await editor.focus(); await page.keyboard.insertText(source);
  await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home');
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: '文本工具…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '文本工具预览', exact: true });
  await expect(dialog.getByLabel('文本工具范围', { exact: true })).toContainText('主选区 · 2:1—5:1');
  await dialog.getByRole('checkbox', { name: '自然排序（数字段）', exact: true }).check();
  await dialog.getByRole('button', { name: '生成变换预览', exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText('b1\nb2\nb10\n');
  await expect(page.locator('.cm-line')).toHaveText(source.split('\n'));
  await dialog.getByRole('button', { name: '应用为一次撤销', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(['外部', 'b1', 'b2', 'b10', '尾部']);
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(source.split('\n'));
});

test('whole-document trim warns for Markdown and cancellation leaves text untouched', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown');
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('Markdown行尾  \n\t缩进\t');
  await page.getByRole('button', { name: '文本工具…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '文本工具预览', exact: true });
  await expect(dialog.getByLabel('文本工具范围', { exact: true })).toContainText('全文');
  await expect(dialog.getByRole('note').filter({ hasText: 'Markdown代码' })).toBeVisible();
  await dialog.getByRole('combobox', { name: '文本变换操作', exact: true }).selectOption('trim');
  await dialog.getByRole('button', { name: '生成变换预览', exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText('Markdown行尾\n\t缩进');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(['Markdown行尾  ', '\t缩进\t']);
});

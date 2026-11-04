import { expect, test } from './test-fixture';

test('top menus run existing commands, preserve document state and restore focus', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const file = page.getByRole('menubar').getByRole('menuitem', { name: '文件', exact: true });
  await file.click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('menu').getByRole('menuitem', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('保留正文与撤销');
  await page.getByRole('menubar').getByRole('menuitem', { name: '转到', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: '跳转到行列', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('保留正文与撤销');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await expect(page.locator('.document-toolbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('menu keyboard navigation wraps, dismisses and reports unavailable actions', async ({ page }) => {
  await page.goto('/');
  const file = page.getByRole('menubar').getByRole('menuitem', { name: '文件', exact: true });
  await file.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu').getByRole('menuitem', { name: '新建文本', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menu').getByRole('menuitem', { name: '重新打开关闭的标签', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu').getByRole('menuitem', { name: '新建文本', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menu')).toHaveAccessibleName('工具');
  const find = page.getByRole('menu').getByRole('menuitem', { name: '文件内查找与替换', exact: true });
  await expect(find).toBeDisabled();
  await expect(find).toHaveAttribute('title', '请先打开或新建文档。');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('menubar').getByRole('menuitem', { name: '工具', exact: true })).toBeFocused();
  await file.click();
  await page.locator('.welcome h1').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('document options remain functional and the explorer gives the tree priority', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+n');
  await page.locator('.document-options > summary').click();
  await page.getByRole('combobox', { name: '缩进宽度', exact: true }).selectOption('2');
  await page.getByRole('combobox', { name: '语言模式', exact: true }).selectOption('javascript');
  await page.getByRole('checkbox', { name: '自动配对', exact: true }).uncheck();
  await page.getByRole('button', { name: '编码与换行', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编码与换行', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '编码与换行', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.document-options')).not.toHaveAttribute('open', '');
  await page.locator('.document-options > summary').click();
  await expect(page.getByRole('combobox', { name: '缩进宽度', exact: true })).toHaveValue('2');
  await expect(page.getByRole('checkbox', { name: '自动配对', exact: true })).not.toBeChecked();
  await page.getByRole('menubar').getByRole('menuitem', { name: '视图', exact: true }).click();
  await expect(page.locator('.document-options')).not.toHaveAttribute('open', '');
  await page.getByRole('menu').getByRole('menuitem', { name: '向右拆分编辑器', exact: true }).click();
  await expect(page.locator('.editor-group')).toHaveCount(2);
  const sections = page.locator('.sidebar-section');
  await expect(sections).toHaveCount(3);
  await expect(sections.locator(':scope > summary')).toHaveText(['工作区管理', '最近打开 0', '收藏 0']);
  await expect(sections.locator('[open]')).toHaveCount(0);
  await sections.filter({ hasText: '最近打开' }).locator('summary').click();
  await expect(page.getByRole('group', { name: '最近记录类型', exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 560 }]) {
  test(`menus and editor fit ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.keyboard.press('Control+n');
    await page.keyboard.insertText('轻羽 FeatherPad\n\n文件、编辑、视图与工具统一在顶部菜单。\n正文保留更多空间，常用快捷键继续可用。\n\nCtrl+S  保存\nCtrl+P  快速打开\nCtrl+Shift+P  命令面板');
    await page.getByRole('menubar').getByRole('menuitem', { name: '视图', exact: true }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeInViewport();
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: test.info().outputPath(`layout-${viewport.width}-menu.png`) });
    await page.keyboard.press('Escape');
    const content = await page.locator('.cm-content').boundingBox();
    expect(content!.y).toBeLessThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`layout-${viewport.width}-editor.png`) });
  });
}

test('dark theme and 200 percent Web zoom keep the menu and command focus usable', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/');
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('200% 缩放下继续编辑');
  await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.getByRole('menubar').getByRole('menuitem', { name: '工具', exact: true }).click();
  await expect(page.getByRole('menu')).toBeInViewport();
  const box = await page.getByRole('menu').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(2560);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1440);
  await page.getByRole('menu').getByRole('menuitem', { name: '文件内查找与替换', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '查找内容', exact: true })).toBeFocused();
  await expect(page.locator('.cm-content')).toHaveText('200% 缩放下继续编辑');
  await page.screenshot({ path: test.info().outputPath('layout-dark-200.png') });
});

import { documentOptions, resumeEditing } from '../ui-actions';
import { expect, test } from './test-fixture';

test('typing and undo survive a delayed optional Markdown module', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/MarkdownView-[^/]+\.js$/, async route => {
    await gate; await route.continue();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '新建文本', exact: true }).click();
    await page.locator('.cm-content').focus(); await page.keyboard.insertText('before load');
    await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown'); await resumeEditing(page);
    await expect(page.getByRole('status').filter({ hasText: '正在加载视图' })).toBeVisible();
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' while loading');
    release();
    await expect(page.getByRole('group', { name: '主编辑组 Markdown视图' })).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveText('before load while loading');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-content')).toHaveText('before load');
  } finally { release(); }
});

test('an unavailable optional view preserves source and offers a working retry', async ({ page }) => {
  let fail = true;
  await page.route(/\/assets\/MarkdownView-[^/]+\.js$/, async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, body: 'controlled module failure' }); }
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('kept source');
  await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown'); await resumeEditing(page);
  await expect(page.getByRole('alert').filter({ hasText: '视图加载失败' })).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveText('kept source');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('group', { name: '主编辑组 Markdown视图' })).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveText('kept source');
});

test('a newly loaded viewer waits for active composition and keeps its committed text', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/MarkdownView-[^/]+\.js$/, async route => { await gate; await route.continue(); });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '新建文本', exact: true }).click();
    await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown'); await resumeEditing(page);
    const editor = page.locator('.cm-content'); await editor.focus();
    await editor.dispatchEvent('compositionstart', { data: '' });
    const fetched = page.waitForResponse(/\/assets\/MarkdownView-[^/]+\.js$/);
    release(); await fetched;
    await page.evaluate(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await expect(page.getByRole('group', { name: '主编辑组 Markdown视图' })).toHaveCount(0);
    await page.keyboard.insertText('组合保留');
    await editor.dispatchEvent('compositionend', { data: '组合保留' });
    await expect(page.getByRole('group', { name: '主编辑组 Markdown视图' })).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveText('组合保留');
    await expect(page.locator('.cm-content')).toBeFocused();
  } finally { release(); }
});

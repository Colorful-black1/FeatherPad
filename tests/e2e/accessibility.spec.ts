import { documentOptions, resumeEditing } from '../ui-actions';
import { expect, test } from './test-fixture';

test('editor Tab focus can be discovered, toggled and retained through view recreation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  const toggle = page.getByRole('button', { name: 'Tab 移动焦点', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(editor).toHaveAttribute('aria-description', /Esc.*Tab/);
  await editor.focus();
  await page.keyboard.insertText('one\n  two');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cm-line')).toHaveText(['    one', '      two']);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(['one', '  two']);
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  await page.locator('.cm-announced').evaluate(element => {
    const messages: string[] = [];
    Reflect.set(window, 'keyboardAnnouncements', messages);
    const observer = new MutationObserver(() => {
      const message = element.textContent?.trim();
      if (message) messages.push(message);
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
  });
  await page.keyboard.press('Control+m');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'keyboardAnnouncements')))
    .toContain('Tab 移动焦点已开启。');
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(editor).toBeFocused();
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: /无标题 1/ }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await (await documentOptions(page)).getByRole('combobox', { name: '缩进宽度', exact: true }).selectOption('2'); await resumeEditing(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await editor.focus();
  await page.keyboard.press('Control+m');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(page.locator('.cm-line')).toHaveText(['one', '  two']);
  await page.screenshot({ path: test.info().outputPath('editor-tab-focus.png') });
  expect(errors).toEqual([]);
});

test('focus-mode button returns to the editor and does not add an undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  const toggle = page.getByRole('button', { name: 'Tab 移动焦点', exact: true });
  await editor.focus();
  await page.keyboard.insertText('中文😀');
  await toggle.click();
  await expect(editor).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await expect(page.getByRole('tab', { name: /无标题 1/ })).not.toContainText('●');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('Web mock: a read-only editor leaves with Tab keys without changing its content', async ({ page }) => {
  await page.addInitScript(() => {
    const ref = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const metadata = { displayPath: 'readonly.txt', sizeBytes: 8, isReadOnly: true,
      modifiedAt: '2026-11-02T00:00:00Z', diskRevision: 'readonly-revision' };
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null,
          settings: { recentHistoryEnabled: false }, warning: null, recoveryCopies: [] });
        case 'list_font_families': return ok({ families: ['Cascadia Mono'], truncated: false });
        case 'choose_files': return ok({ grants: [ref], failures: [] });
        case 'open_document': return ok({ documentId: '22222222-2222-4222-8222-222222222222', ref, metadata,
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: 'readonly', newlineMap: { documentVersion: 0, endings: [] } } });
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'readonly-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档内容（只读）', exact: true });
  const toggle = page.getByRole('button', { name: 'Tab 移动焦点', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeDisabled();
  await expect(editor).toHaveAttribute('aria-description', /只读.*移动焦点/);
  await expect(page.getByRole('tab', { name: 'readonly.txt', exact: true })).toHaveAttribute('aria-description', /只读/);
  await expect(page.getByRole('button', { name: '关闭 readonly.txt，只读', exact: true })).toBeVisible();
  await editor.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(editor).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveText('readonly');
  await expect(page.getByRole('tab', { name: 'readonly.txt', exact: true })).not.toContainText('●');
});

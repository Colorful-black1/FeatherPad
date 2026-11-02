import { expect, test } from './test-fixture';
import { writeFile } from 'node:fs/promises';

test('Web search: Unicode-safe options, navigation, capture replacement and single undo', async ({ page }) => {
  await page.goto('/');
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
  await page.screenshot({ path: test.info().outputPath('search-web.png') });
});

test('Web search: CtrlF captures the current selection as a replaceable scope', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText('cat cat cat');
  await page.keyboard.press('Control+Home');
  for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+f');
  const findBar = page.locator('.find-bar');
  await findBar.getByRole('textbox', { name: '查找内容' }).fill('cat');
  await expect(findBar).toContainText('查找范围：当前选区');
  await expect(findBar.locator('.find-result')).toContainText('1 处');
  await findBar.getByRole('textbox', { name: '替换内容' }).fill('dog');
  await findBar.getByRole('button', { name: '替换当前' }).click();
  await expect(editor).toHaveText('cat dog cat');
  await expect(findBar).toContainText('文档已变化，查找范围已安全重置为全文');
});

test('Web search: replacing one result resumes at the following match', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText('cat cat cat');
  await page.keyboard.press('Control+f');
  const findBar = page.locator('.find-bar');
  await findBar.getByRole('textbox', { name: '查找内容' }).fill('cat');
  await expect(findBar.locator('.find-result')).toContainText('3 处');
  await findBar.getByRole('button', { name: '下一个匹配' }).click();
  await expect(findBar.locator('.find-result')).toContainText('2/3');
  await findBar.getByRole('textbox', { name: '替换内容' }).fill('dog');
  await findBar.getByRole('button', { name: '替换当前' }).click();
  await expect(editor).toHaveText('cat dog cat');
  await expect(findBar.locator('.find-result')).toContainText('2/2');
});

test('Web search: a new query terminates stale worker work promptly', async ({ page }) => {
  await page.addInitScript(() => {
    const text = `${'a'.repeat(200_000)}b`;
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'large-search', relativePath: '' }], failures: [] } };
        if (command === 'open_document') return { ok: true, value: {
          documentId: 'large-search-document', ref: { grantId: 'large-search', relativePath: '' },
          metadata: { displayPath: 'large-search.txt', sizeBytes: text.length, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'revision' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text, newlineMap: { documentVersion: 0, endings: [] } },
        } };
        throw new Error('Unexpected Web mock command');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+f');
  const findBar = page.locator('.find-bar');
  const query = findBar.getByRole('textbox', { name: '查找内容' });
  await findBar.getByRole('checkbox', { name: '安全正则' }).check();
  await query.fill('(a+)+$');
  await page.waitForTimeout(50);
  const startedAt = performance.now();
  await query.fill('needle');
  await expect(findBar.locator('.find-result')).toHaveText('0 处');
  const elapsedMs = performance.now() - startedAt;
  expect(elapsedMs).toBeLessThan(250);
  await writeFile(test.info().outputPath('cancellation-web.json'), JSON.stringify({
    scope: 'Web worker cancellation with a pathological regular expression; UI receives the replacement query result',
    measuredMs: elapsedMs,
    budgetMs: 250,
  }, null, 2));
});

test('Web mock: read-only documents can search but replacement controls stay disabled', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'readonly', relativePath: '' }], failures: [] } };
        if (command === 'open_document') return { ok: true, value: {
          documentId: 'readonly-document', ref: { grantId: 'readonly', relativePath: '' },
          metadata: { displayPath: 'readonly.txt', sizeBytes: 14, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: true, diskRevision: 'revision' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: 'FeatherPad\nFeatherPad', newlineMap: { documentVersion: 0, endings: ['lf'] } },
        } };
        throw new Error('Unexpected Web mock command');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+f');
  const findBar = page.locator('.find-bar');
  await findBar.getByRole('textbox', { name: '查找内容' }).fill('Feather');
  await expect(findBar.locator('.find-result')).toContainText('2 处');
  await expect(findBar.getByRole('textbox', { name: '替换内容' })).toBeDisabled();
  await expect(findBar.getByRole('button', { name: '替换当前' })).toBeDisabled();
  await expect(findBar.getByRole('button', { name: /全部替换/ })).toBeDisabled();
  await expect(findBar).toContainText('只读文档仅支持查找');
});

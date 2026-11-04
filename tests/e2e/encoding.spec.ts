import { documentOptions } from '../ui-actions';
import { test, expect } from './test-fixture';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let version = 0;
    const ref = { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' };
    const metadata = { displayPath: 'E:\\fixtures\\legacy.txt', sizeBytes: 20,
      modifiedAt: '2026-11-03T00:00:00Z', diskRevision: 'a'.repeat(64), isReadOnly: false };
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      if (command === 'load_settings') return ok({ schemaVersion: 1, version,
        revision: 'a'.repeat(64), settings: {}, warning: null, recoveryCopies: [] });
      if (command === 'save_settings') return ok({ version: ++version, revision: 'a'.repeat(64) });
      if (command === 'choose_files') return ok({ grants: [ref], failures: [] });
      if (command === 'open_document') return args.encodingOverride === 'gbk'
        ? ok({ documentId: '11111111-1111-4111-8111-111111111111', ref, metadata,
          format: { encoding: 'gbk', bom: 'none', lineEnding: 'mixed' }, mode: 'normal', warnings: [],
          content: { kind: 'text', text: '中文\nsecond\nthird', newlineMap: { documentVersion: 0, endings: ['cr', 'lf'] } } })
        : { ok: false, error: { code: 'ENCODING_REQUIRED', message: '请选择编码', retryable: false } };
      if (command === 'start_watch') return ok({ watchId: 'encoding-watch' });
      if (command === 'stop_watch') return ok({ stopped: true });
      if (command === 'stat_document') return ok(metadata);
      if (command === 'check_encoding') {
        if (typeof args.text !== 'string' || typeof args.encoding !== 'string') throw new Error('Invalid fixture input');
        const samples: { offset: number; length: number }[] = [];
        let candidate = ''; let offset = 0; let lossCount = 0;
        for (const character of args.text) {
          if (args.encoding === 'windows-1252' && character.codePointAt(0)! > 255) {
            candidate += '?'; lossCount++; if (samples.length < 32) samples.push({ offset, length: character.length });
          } else candidate += character;
          offset += character.length;
        }
        return ok({ encoding: args.encoding, documentVersion: args.documentVersion,
          lossCount, samples, replacementText: lossCount ? candidate : null });
      }
      throw new Error(`Unexpected business command ${command}`);
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
});

test('Web mock: encoding loss defaults to cancel, explicit conversion and its text changes undo together', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.focus(); await page.keyboard.insertText('A😀中\nB');
  const trigger = (await documentOptions(page)).getByRole('button', { name: '编码与换行', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '编码与换行', exact: true });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('combobox', { name: '目标编码', exact: true }).selectOption('windows-1252');
  await dialog.getByRole('button', { name: '应用转换', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '有 2 个字符无法无损表示' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(editor).toHaveText('A😀中B');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.locator('.status-end')).toContainText('UTF-8');
  await trigger.click();
  await dialog.getByRole('combobox', { name: '目标编码', exact: true }).selectOption('windows-1252');
  await dialog.getByRole('button', { name: '应用转换', exact: true }).click();
  await dialog.getByRole('button', { name: '确认替换为 ? 并转换', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor).toHaveText('A??B');
  await expect(page.locator('.status-end')).toContainText('WINDOWS-1252');
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('A😀中B');
  await expect(page.locator('.status-end')).toContainText('UTF-8');
});

test('Web mock: UTF16 BOM and newline-only intent are accessible and undoable at 200 percent', async ({ page }, testInfo) => {
  const editor = page.locator('.cm-content');
  await editor.focus(); await page.keyboard.insertText('中文\nsecond');
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await (await documentOptions(page)).getByRole('button', { name: '编码与换行', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编码与换行', exact: true });
  await dialog.getByRole('combobox', { name: '目标编码', exact: true }).selectOption('utf-16le');
  await expect(dialog.getByRole('combobox', { name: '目标BOM', exact: true })).toHaveValue('utf16le');
  await dialog.getByRole('combobox', { name: '目标换行', exact: true }).selectOption('lf');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '应用转换', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('encoding-dialog-200.png') });
  await dialog.getByRole('button', { name: '应用转换', exact: true }).click();
  await expect(page.locator('.status-end')).toContainText('UTF-16LE BOM · LF');
  await expect(editor).toHaveText('中文second');
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.status-end')).toContainText('UTF-8 · CRLF');
});

test('Web mock: failed strict open offers explicit encoding without replacing an existing buffer', async ({ page }) => {
  const draftId = await page.getByRole('tab', { selected: true }).getAttribute('id');
  expect(draftId).not.toBeNull();
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('existing private draft');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await page.getByRole('combobox', { name: '所选文件 1 的打开编码', exact: true }).selectOption('gbk');
  await page.getByRole('button', { name: '按编码打开所选文件 1', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('中文secondthird');
  await expect(page.locator('.status-end')).toContainText('GBK · MIXED');
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nadded');
  await expect(page.locator('.cm-content')).toHaveText('中文secondthirdadded');
  await page.locator(`[id="${draftId}"]`).click();
  await expect(page.locator('.cm-content')).toHaveText('existing private draft');
});

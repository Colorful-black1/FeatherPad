import { expect, test } from './test-fixture';

test('Web mock: multi-open isolates failures, retains buffers/undo and sends no per-key IPC', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const calls: { command: string; args: unknown }[] = [];
    Reflect.set(window, 'fixtureCalls', calls);
    let selections = 0;
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, args: { multiple?: boolean; ref?: { grantId: string } }) => {
        calls.push({ command, args });
        if (command === 'list_font_families') return { ok: true, value: { families: ['Consolas'], truncated: false } };
        if (command === 'load_settings') return { ok: true, value: {
          schemaVersion: 1, version: 1, revision: 'a'.repeat(64), settings: { recentHistoryEnabled: false },
          warning: null, recoveryCopies: [],
        } };
        if (command === 'start_watch') return { ok: true, value: { watchId: 'documents-watch' } };
        if (command === 'stop_watch') return { ok: true, value: { stopped: true } };
        if (command === 'choose_files') {
          selections++;
          return { ok: true, value: { grants: (selections === 1 ? ['first', 'denied', 'second'] : ['first']).map(grantId => ({ grantId, relativePath: '' })),
            failures: selections === 1 ? [{ selectionIndex: 1, error: { code: 'NOT_FOUND', message: '受控选择项已消失', retryable: false } }] : [] } };
        }
        if (command === 'open_document') {
          const id = args.ref?.grantId;
          if (id === 'denied') return { ok: false, error: { code: 'PERMISSION_DENIED', message: '受控文件无权限', retryable: false } };
          return { ok: true, value: {
            documentId: id, ref: { grantId: id, relativePath: '' },
            metadata: { displayPath: `${id === 'first' ? '中文 fixture' : 'second'}.txt`, sizeBytes: 12, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'fixture-revision' },
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
            content: { kind: 'text', text: `${id} original`, newlineMap: { documentVersion: 0, endings: [] } },
          } };
        }
        throw new Error('Unexpected test command');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('alert')).toContainText('受控文件无权限');
  await expect(page.getByRole('alert')).toContainText('第 2 个所选文件：受控选择项已消失');
  await expect(page.locator('.cm-content')).toHaveText('second original');
  const first = page.getByRole('tab', { name: /中文 fixture/ });
  await first.click();
  const editor = page.locator('.cm-content');
  await editor.click();
  const beforeTyping = await page.evaluate(() => structuredClone(Reflect.get(window, 'fixtureCalls')) as { command: string; args: unknown }[]);
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 中文😀未保存');
  await expect(first).toContainText('●');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await page.getByRole('tab', { name: 'second.txt', exact: true }).click();
  await expect(editor).toHaveText('second original');
  await first.click();
  await expect(editor).toContainText('first original 中文😀未保存');
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('first original');
  await expect(page.getByRole('status')).toContainText('未修改');
  await page.keyboard.press('Control+y');
  await expect(editor).toContainText('中文😀未保存');
  const calls = await page.evaluate(() => Reflect.get(window, 'fixtureCalls') as { command: string; args: unknown }[]);
  expect(calls).toEqual(beforeTyping);
  const fileCalls = calls.filter(call => call.command === 'choose_files' || call.command === 'open_document');
  expect(fileCalls.map(call => call.command)).toEqual(['choose_files', 'open_document', 'open_document', 'open_document']);
  expect(fileCalls[0]?.args).toEqual({ multiple: true });
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor).toContainText('中文😀未保存');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'second.txt', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('tab', { name: '无标题 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.insertText('新草稿');
  await expect(editor).toHaveText('新草稿');
  await first.click();
  await expect(editor).toContainText('中文😀未保存');
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('documents-web.png') });
});

test('new document keyboard input stays usable at 200 percent zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.goto('/');
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.keyboard.insertText('中文😀\n独立草稿');
  await expect(page.locator('.cm-line')).toHaveText(['中文😀', '独立草稿']);
  await page.keyboard.press('Control+n');
  await page.keyboard.insertText('第二份');
  await page.getByRole('tab', { name: /无标题 1/ }).click();
  await expect(page.locator('.cm-line')).toHaveText(['中文😀', '独立草稿']);
  await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeInViewport();
  await expect(page.locator('.cm-editor')).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('documents-zoom200.png') });
});

test('Web mock: all selection grants failing leaves existing content intact and an empty cancellation clears the notice', async ({ page }) => {
  await page.addInitScript(() => {
    let selections = 0;
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string) => {
      if (command !== 'choose_files') throw new Error('Failed selections must not reach open_document');
      selections++;
      return { ok: true, value: { grants: [], failures: selections === 1 ? [
        { selectionIndex: 0, error: { code: 'NOT_FOUND', message: '受控文件已消失', retryable: false } },
        { selectionIndex: 1, error: { code: 'PERMISSION_DENIED', message: '受控授权失败', retryable: false } },
      ] : [] } };
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.keyboard.insertText('已有草稿😀仍保留');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第 1 个所选文件：受控文件已消失');
  await expect(page.getByRole('alert')).toContainText('第 2 个所选文件：受控授权失败');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toHaveText('已有草稿😀仍保留');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveText('已有草稿😀仍保留');
});

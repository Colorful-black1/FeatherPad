import { expect, test } from './test-fixture';

for (const code of ['IS_BINARY', 'ENCODING_REQUIRED', 'LOSSY_ENCODING', 'LARGE_BINARY']) {
  test(`Web mock offers explicit read-only text preview after ${code} without creating a writable buffer`, async ({ page }) => {
    await page.addInitScript(({ code }) => {
      const large = code === 'LARGE_BINARY';
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      Reflect.set(window, 'previewCalls', calls);
      const ref = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
      Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        const ok = (value: unknown) => ({ ok: true, value });
        if (command === 'load_settings') return ok({ schemaVersion: 1, version: 1, revision: 'a'.repeat(64),
          settings: { recentHistoryEnabled: false }, warning: null, recoveryCopies: [] });
        if (command === 'list_font_families') return ok({ families: ['Consolas'], truncated: false });
        if (command === 'start_watch') return ok({ watchId: 'preview-watch' });
        if (command === 'stop_watch') return ok({ stopped: true });
        if (command === 'choose_files') return ok({ grants: [ref], failures: [] });
        if (command === 'release_document') return ok({ released: true });
        if (command !== 'open_document') throw new Error(`Unexpected preview command: ${command}`);
        if (args.mode !== 'text-preview') return { ok: false, error: { code: large ? 'IS_BINARY' : code, message: '受控二进制或编码错误', retryable: false } };
        return ok({ documentId: '22222222-2222-4222-8222-222222222222', ref,
          metadata: { displayPath: 'binary.html', sizeBytes: large ? 20 * 1024 * 1024 : 8, modifiedAt: '2026-11-02T00:00:00Z',
            isReadOnly: false, diskRevision: 'b'.repeat(64) },
          mode: 'text-preview', format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
          warnings: ['控制字符已可见化显示，原始字节未改变。'],
          content: { kind: 'head', text: large ? '␀'.repeat(1024 * 1024) : 'a␀�<script>window.previewExecuted=true</script>',
            previewBytes: large ? 1024 * 1024 : 8, totalBytes: large ? 20 * 1024 * 1024 : 8, truncated: large },
        });
      } });
    }, { code });
    await page.goto('/');
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    if (code === 'IS_BINARY') {
      await page.setViewportSize({ width: 1600, height: 1200 });
      await page.locator('html').evaluate(element => { element.style.zoom = '2'; });
    }
    await expect(page.getByRole('button', { name: '只读试开所选文件 1', exact: true })).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveCount(0);
    await page.getByRole('button', { name: '只读试开所选文件 1', exact: true }).click();
    const editor = page.locator('.cm-content');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    if (code === 'LARGE_BINARY') {
      await expect(page.getByText('已试读 1,048,576 / 20,971,520 字节，内容已截断。', { exact: true })).toBeVisible();
      await expect(editor).toContainText('␀');
      await expect(editor).not.toHaveClass(/cm-lineWrapping/);
    } else await expect(editor).toHaveText('a␀�<script>window.previewExecuted=true</script>');
    await expect(page.getByText('只读试开', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('auto');
    await expect(page.getByRole('combobox', { name: '语言模式', exact: true })).toBeDisabled();
    for (const name of ['保存', '另存为', '保存副本']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await editor.focus();
    await page.keyboard.type('cannot edit');
    await page.keyboard.press('Control+s');
    if (code === 'LARGE_BINARY') await expect(editor).toContainText('␀');
    else await expect(editor).toHaveText('a␀�<script>window.previewExecuted=true</script>');
    expect(await page.evaluate(() => Reflect.get(window, 'previewExecuted'))).toBeUndefined();
    const calls = await page.evaluate(() => Reflect.get(window, 'previewCalls') as { command: string; args: Record<string, unknown> }[]);
    expect(calls.filter(call => call.command === 'open_document').map(call => call.args.mode)).toEqual([undefined, 'text-preview']);
    expect(calls.filter(call => call.command.startsWith('save_document'))).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('text-preview-readonly.png') });
  });
}

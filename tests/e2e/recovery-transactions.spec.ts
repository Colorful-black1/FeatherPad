import { expect, test } from '@playwright/test';

test('transaction candidates fail visibly and open independent copies with explicit protection status', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const receiptId = '2da72636-c5a0-4561-b8f4-e5e0ed100af4';
    Reflect.set(window, 'recoveryCalls', calls);
    Reflect.set(window, 'recoveryLoadFails', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        const fail = (code: string, message: string) => ({ ok: false, error: { code, message, retryable: false } });
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'set_global_shortcut') return { ok: true, value: { enabled: false } };
        if (command === 'load_session') return { ok: true, value: { session: null, warning: null, restoredGrantIds: [] } };
        if (command === 'save_session') {
          const manifest = args.manifest as { persistedAt: string };
          return { ok: true, value: { saved: true, persistedAt: manifest.persistedAt } };
        }
        if (command === 'list_recovery_entries') return { ok: true, value: {
          entries: [], failures: [], startupWarnings: [], storageBytes: 2048,
          saveTransactions: [{ receiptId, displayName: '中文 draft.txt', bufferVersion: 7, bodyBytes: 10 }],
        } };
        if (command === 'load_save_transaction') {
          if (Reflect.get(window, 'recoveryLoadFails')) return fail('INVALID_INPUT', '恢复正文校验失败，原记录保留。');
          return { ok: true, value: { receiptId, displayName: '中文 draft.txt', text: '未保存😀\n正文',
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
            newlineMap: { documentVersion: 1, endings: ['crlf'] } } };
        }
        if (command === 'write_recovery_snapshot') return fail('DISK_FULL', '受控恢复容量不足');
        return fail('UNSUPPORTED', `Unexpected mock command ${command}`);
      },
    });
  });
  await page.goto('/');
  const panel = page.locator('.recovery-panel');
  await page.getByRole('button', { name: '显示本地恢复', exact: true }).click();
  const open = panel.getByRole('button', { name: '打开恢复副本：中文 draft.txt', exact: true });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toContainText('校验失败');
  await expect(page.getByRole('tab')).toHaveCount(0);

  await page.evaluate(() => Reflect.set(window, 'recoveryLoadFails', false));
  await open.click();
  await expect(page.locator('.cm-content')).toHaveText('未保存😀正文');
  await expect(panel.getByRole('status')).toContainText('恢复快照未更新');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.document-view')).toContainText('另存为新文件');
  await expect(page.locator('.document-view')).toContainText('尚未确认新的恢复快照');
  await open.click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  const commands = await page.evaluate(() => Reflect.get(window, 'recoveryCalls') as { command: string }[]);
  expect(commands.filter(call => call.command === 'load_save_transaction')).toHaveLength(2);
  expect(commands.some(call => ['save_document', 'save_document_as', 'trash_entry', 'discard_recovery'].includes(call.command))).toBe(false);

  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  await expect(open).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('recovery-200-percent.png') });
});

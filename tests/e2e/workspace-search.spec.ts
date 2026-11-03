import { expect, test } from './test-fixture';

test('workspace search preserves dirty buffers, forwards filters and completes a native-style cancellation', async ({ page }) => {
  await page.addInitScript(() => {
    type Ref = { grantId: string; relativePath: string };
    const root: Ref = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const a: Ref = { grantId: root.grantId, relativePath: 'a.txt' };
    const b: Ref = { grantId: root.grantId, relativePath: 'src/b.txt' };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    let cancelRequestId = '';
    Reflect.set(window, 'searchCalls', calls);
    const result = (requestId: string, pattern: string) => ({
      requestId,
      files: pattern === 'cancel-me' ? [] : [
        {
          ref: a, displayName: 'a.txt', displayPath: 'E:/controlled-project/a.txt',
          revision: 'a'.repeat(64), encoding: 'utf-8',
          matches: [{ line: 1, column: 1, start: 0, end: 5, snippet: 'alpha disk', prefixTruncated: false, suffixTruncated: false }],
          truncated: false,
        },
        {
          ref: b, displayName: 'b.txt', displayPath: 'E:/controlled-project/src/b.txt',
          revision: 'b'.repeat(64), encoding: 'utf-8',
          matches: [{ line: 2, column: 3, start: 8, end: 13, snippet: 'prefix alpha suffix', prefixTruncated: false, suffixTruncated: false }],
          truncated: false,
        },
      ],
      skipped: [{ reason: '二进制文件', count: 1 }],
      totalMatches: pattern === 'cancel-me' ? 1 : 2,
      scannedFiles: 2,
      truncated: false,
      cancelled: pattern === 'cancel-me',
      elapsedMs: pattern === 'cancel-me' ? 25 : 12,
    });
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        const ok = (value: unknown) => Promise.resolve({ ok: true, value });
        switch (command) {
          case 'load_settings': return ok({
            schemaVersion: 1, version: 0, revision: null, settings: {}, warning: null, recoveryCopies: [],
          });
          case 'save_settings': return ok({ version: Number(args.expectedVersion) + 1, revision: 'c'.repeat(64) });
          case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
          case 'choose_folder': return ok({ grant: root, displayName: 'controlled-project' });
          case 'inspect_workspace_root': return ok({
            ref: root, displayName: 'controlled-project', displayPath: 'E:/controlled-project',
            canonicalIdentity: 'd'.repeat(64),
          });
          case 'list_directory': return ok({
            items: [{
              id: 'a.txt', ref: a, name: 'a.txt', kind: 'file', isHidden: false, isReadOnly: false,
              revision: 'a'.repeat(64),
            }],
            nextCursor: null,
          });
          case 'open_document': return ok({
            documentId: '22222222-2222-4222-8222-222222222222',
            ref: a,
            metadata: {
              displayPath: 'E:/controlled-project/a.txt', sizeBytes: 11,
              modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: 'a'.repeat(64),
            },
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
            mode: 'normal', warnings: [],
            content: { kind: 'text', text: 'alpha disk', newlineMap: { documentVersion: 0, endings: [] } },
          });
          case 'stat_document': return ok({
            displayPath: 'E:/controlled-project/a.txt', sizeBytes: 11,
            modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: 'a'.repeat(64),
          });
          case 'start_watch': return ok({ watchId: 'workspace-search-watch' });
          case 'stop_watch': return ok({ stopped: true });
          case 'search_workspace': {
            const requestId = String(args.requestId);
            if (args.pattern === 'cancel-me') {
              cancelRequestId = requestId;
              return new Promise(resolve => {
                setTimeout(() => resolve({ ok: true, value: result(requestId, 'cancel-me') }), 750);
              });
            }
            return ok(result(requestId, String(args.pattern)));
          }
          case 'cancel_workspace_search':
            if (args.requestId !== cancelRequestId) {
              return Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT', message: 'stale request', retryable: false } });
            }
            return ok({ requestId: cancelRequestId });
          default: throw new Error(`Unexpected business command ${command}`);
        }
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'controlled-project 文件树', exact: true });
  await tree.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' draft');
  await page.keyboard.press('Control+Shift+f');

  const panel = page.getByRole('region', { name: /在文件和文件夹中查找/ });
  await panel.getByLabel('搜索内容', { exact: true }).fill('alpha');
  await panel.getByLabel('包含 glob').fill('*.txt, src/**');
  await panel.getByLabel('排除 glob').fill('*.min.js');
  await panel.getByLabel('包含隐藏项').check();
  await panel.getByRole('button', { name: '开始搜索', exact: true }).click();
  const dirtyResult = panel.locator('details').filter({ hasText: 'a.txt' });
  const diskResult = panel.locator('details').filter({ hasText: 'b.txt' });
  await expect(dirtyResult).toContainText('alpha disk draft');
  await expect(panel.getByText('未保存缓冲', { exact: true })).toBeVisible();
  await expect(diskResult).toContainText('alpha');
  await expect(panel.getByText('没有匹配结果。')).toHaveCount(0);
  await panel.getByText('跳过与限制', { exact: true }).click();
  await expect(panel.getByText('二进制文件：1')).toBeVisible();

  let calls = await page.evaluate(() =>
    Reflect.get(window, 'searchCalls') as { command: string; args: Record<string, unknown> }[]);
  const first = calls.find(call => call.command === 'search_workspace');
  expect(first?.args).toMatchObject({
    pattern: 'alpha',
    include: ['*.txt', 'src/**'],
    exclude: ['*.min.js'],
    includeHidden: true,
    maxMatches: 10_000,
  });

  await panel.getByLabel('搜索内容', { exact: true }).fill('cancel-me');
  await panel.getByRole('button', { name: '开始搜索', exact: true }).click();
  await expect(panel.getByRole('button', { name: '取消搜索', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '取消搜索', exact: true }).click();
  await expect(panel.getByText('已取消，结果不完整', { exact: false })).toBeVisible();
  calls = await page.evaluate(() =>
    Reflect.get(window, 'searchCalls') as { command: string; args: Record<string, unknown> }[]);
  expect(calls.some(call => call.command === 'cancel_workspace_search')).toBe(true);
});

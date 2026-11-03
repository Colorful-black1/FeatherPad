import { expect, test } from './test-fixture';

test('workspace replacement shows only writable files, requires final confirmation and exposes rollback outcomes', async ({ page }) => {
  await page.addInitScript(() => {
    const root = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const ready = { grantId: root.grantId, relativePath: 'src/ready.txt' };
    const dirty = { grantId: root.grantId, relativePath: 'src/dirty.txt' };
    const readOnly = { grantId: root.grantId, relativePath: 'src/read-only.txt' };
    const planId = '22222222-2222-4222-8222-222222222222';
    const token = '33333333-3333-4333-8333-333333333333';
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Reflect.set(window, 'replacementCalls', calls);
    const planFile = (id: string, ref: typeof ready, state: string, matches: number, reason: string | null, snapshot: boolean) => ({
      id,
      ref,
      displayName: ref.relativePath.split('/').at(-1),
      displayPath: `E:/controlled-project/${ref.relativePath}`,
      state,
      reason,
      beforeRevision: 'a'.repeat(64),
      afterRevision: null,
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      encoding: 'utf-8',
      matches,
      previewBefore: 'alpha\n',
      previewAfter: 'omega\n',
      beforeSnapshotRef: snapshot ? `before/${id}.bin` : null,
      afterSnapshotRef: snapshot ? `after/${id}.bin` : null,
    });
    const plan = {
      schemaVersion: 1,
      planId,
      confirmationToken: token,
      createdAt: 1_793_600_000_000,
      expiresAt: 1_793_600_600_000,
      replacement: 'omega',
      files: [
        planFile('44444444-4444-4444-8444-444444444444', ready, 'ready', 2, null, true),
        planFile('55555555-5555-4555-8555-555555555555', dirty, 'dirtySkipped', 1,
          '文件有未保存缓冲；保存或放弃后重新预览。', false),
        planFile('66666666-6666-4666-8666-666666666666', readOnly, 'readOnly', 1,
          '文件为只读；计划不会修改该文件。', false),
      ],
      totalMatches: 4,
      truncated: false,
      skipped: [],
    };
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        const ok = (value: unknown) => ({ ok: true, value });
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
          case 'list_directory': return ok({ items: [], nextCursor: null });
          case 'start_watch': return ok({ watchId: 'replacement-watch' });
          case 'stop_watch': return ok({ stopped: true });
          case 'create_replace_plan': return ok(plan);
          case 'commit_replace_plan': return ok({
            batchId: planId, status: 'completed', succeeded: ['E:/controlled-project/src/ready.txt'],
            failed: [], remaining: [], rollbackJournalRef: `replacement-plans/${planId}`,
          });
          case 'rollback_replace_batch': return ok({
            batchId: planId, status: 'completed', restored: ['E:/controlled-project/src/ready.txt'],
            conflicts: [], failed: [], rollbackJournalRef: `replacement-plans/${planId}`,
          });
          default: throw new Error(`Unexpected business command ${command}`);
        }
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'controlled-project 文件树', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+f');
  const search = page.getByRole('region', { name: /在文件和文件夹中查找/ });
  await search.getByLabel('搜索内容', { exact: true }).fill('alpha');
  await search.getByLabel('替换为', { exact: true }).fill('omega');
  await search.getByRole('button', { name: '预览跨文件替换', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '跨文件替换预览', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 / 1 个可替换文件已选择');
  await expect(dialog).toContainText('跳过 2 个文件');
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.getByRole('checkbox').nth(0)).toBeChecked();
  await expect(dialog.getByRole('checkbox').nth(1)).toBeDisabled();
  await expect(dialog.getByRole('checkbox').nth(2)).toBeDisabled();
  await expect(dialog).toContainText('文件有未保存缓冲');
  await expect(dialog).toContainText('文件为只读');

  const beforeCommit = await page.evaluate(() =>
    (Reflect.get(window, 'replacementCalls') as { command: string; args: Record<string, unknown> }[])
      .filter(call => call.command === 'commit_replace_plan'));
  expect(beforeCommit).toHaveLength(0);
  await dialog.getByRole('button', { name: '继续到最终确认', exact: true }).click();
  await expect(dialog).toContainText('将立即写入 1 个文件，共 2 处替换');
  await dialog.getByRole('button', { name: '确认替换并写入磁盘', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '替换完成', exact: true })).toBeVisible();
  await expect(dialog).toContainText('1 个文件已写入');

  const calls = await page.evaluate(() =>
    Reflect.get(window, 'replacementCalls') as { command: string; args: Record<string, unknown> }[]);
  const preview = calls.find(call => call.command === 'create_replace_plan');
  expect(preview?.args).toMatchObject({
    roots: [{ grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' }],
    pattern: 'alpha',
    replacement: 'omega',
    isRegex: false,
    dirtyPaths: [],
  });
  const commit = calls.find(call => call.command === 'commit_replace_plan');
  expect(commit?.args).toEqual({
    planId: '22222222-2222-4222-8222-222222222222',
    confirmationToken: '33333333-3333-4333-8333-333333333333',
    selected: [{ grantId: '11111111-1111-4111-8111-111111111111', relativePath: 'src/ready.txt' }],
  });

  await dialog.getByRole('button', { name: '回滚本次替换', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '回滚完成', exact: true })).toBeVisible();
  await expect(dialog).toContainText('1 个文件已恢复');
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
});

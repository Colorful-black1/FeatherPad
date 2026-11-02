import { expect, test } from './test-fixture';

test('Web mock records successful opens, repairs missing entries, persists removal and honors privacy restart state', async ({ page }) => {
  await page.addInitScript(() => {
    type Ref = { grantId: string; relativePath: string };
    let profile = {
      schemaVersion: 1 as const,
      version: 1,
      revision: 'a'.repeat(64),
      settings: {} as Record<string, unknown>,
      warning: null as string | null,
      recoveryCopies: [] as { id: string; version: number }[],
    };
    let selected = 'a';
    let failNextOpen = false;
    let saveCount = 0;
    const files: Record<string, { ref: Ref; identity: string; title: string; id: string }> = {
      a: {
        ref: { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' },
        identity: '1'.repeat(64), title: 'note-a.txt', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      b: {
        ref: { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' },
        identity: '2'.repeat(64), title: 'repaired-b.txt', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      c: {
        ref: { grantId: '33333333-3333-4333-8333-333333333333', relativePath: '' },
        identity: '3'.repeat(64), title: 'private-c.txt', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    };
    const workspaceRef = { grantId: '44444444-4444-4444-8444-444444444444', relativePath: '' };
    Reflect.set(window, 'recentFixture', {
      get: () => profile,
      saves: () => saveCount,
      select: (id: string) => { selected = id; },
      failNextOpen: () => { failNextOpen = true; },
    });
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, args: Record<string, unknown>) => {
        const ok = (value: unknown) => ({ ok: true, value });
        switch (command) {
          case 'load_settings': return ok(profile);
          case 'save_settings': {
            saveCount++;
            if (args.expectedVersion !== profile.version || args.expectedRevision !== profile.revision) {
              return { ok: false, error: { code: 'CONFLICT', message: '配置已变化', retryable: false } };
            }
            profile = {
              ...profile,
              version: profile.version + 1,
              revision: (profile.version % 2 ? 'b' : 'a').repeat(64),
              settings: args.settings as Record<string, unknown>,
            };
            return ok({ version: profile.version, revision: profile.revision });
          }
          case 'list_font_families': return ok({ families: ['Arial', 'Consolas'], truncated: false });
          case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
          case 'choose_files': {
            const file = files[selected]!;
            return ok({ grants: [file.ref], failures: [] });
          }
          case 'choose_folder': return ok({ grant: workspaceRef, displayName: 'controlled-workspace' });
          case 'list_directory': return ok({ items: [], nextCursor: null });
          case 'open_document': {
            if (failNextOpen) {
              failNextOpen = false;
              return { ok: false, error: { code: 'OUT_OF_SCOPE', message: '最近文件已移动', retryable: false } };
            }
            const ref = args.ref as Ref;
            const file = Object.values(files).find(candidate => candidate.ref.grantId === ref.grantId);
            if (!file) {
              return { ok: false, error: { code: 'OUT_OF_SCOPE', message: '未知文件', retryable: false } };
            }
            return ok({
              documentId: file.id,
              canonicalIdentity: file.identity,
              ref,
              metadata: {
                displayPath: `E:\\fixtures\\${file.title}`,
                sizeBytes: 4,
                modifiedAt: '2026-11-02T00:00:00.000Z',
                isReadOnly: false,
                diskRevision: file.identity,
              },
              format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
              warnings: [],
              mode: 'normal',
              content: {
                kind: 'text',
                text: file.title,
                newlineMap: { documentVersion: 0, endings: [] },
              },
            });
          }
          case 'stat_document': {
            const file = Object.values(files).find(candidate => candidate.id === args.documentId)!;
            return ok({
              displayPath: `E:\\fixtures\\${file.title}`,
              sizeBytes: 4,
              modifiedAt: '2026-11-02T00:00:00.000Z',
              isReadOnly: false,
              diskRevision: file.identity,
            });
          }
          case 'start_watch': return ok({ watchId: 'recent-test-watch' });
          case 'stop_watch': return ok({ stopped: true });
          default: throw new Error(`Unexpected business command ${command}`);
        }
      },
    });
  });

  await page.goto('/');
  const openFile = page.getByRole('button', { name: '打开文件', exact: true });
  await openFile.click();
  await expect(page.locator('.cm-content')).toHaveText('note-a.txt');

  const recent = page.getByRole('region', { name: '最近' });
  await expect(recent.getByRole('button', { name: '打开note-a.txt', exact: true })).toBeVisible();
  await openFile.click();
  await expect(recent.locator(`[data-recent-id="file:${'1'.repeat(64)}"]`)).toHaveCount(1);

  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(recent.getByRole('button', { name: '打开controlled-workspace', exact: true })).toBeVisible();
  await recent.getByRole('button', { name: '文件', exact: true }).click();
  await expect(recent.getByRole('button', { name: '打开controlled-workspace', exact: true })).toHaveCount(0);
  await recent.getByRole('button', { name: '工作区', exact: true }).click();
  await expect(recent.getByRole('button', { name: '打开note-a.txt', exact: true })).toHaveCount(0);
  await recent.getByRole('button', { name: '全部', exact: true }).click();

  await page.evaluate(() => {
    (Reflect.get(window, 'recentFixture') as { failNextOpen: () => void }).failNextOpen();
  });
  await recent.getByRole('button', { name: '打开note-a.txt', exact: true }).click();
  const missingRow = recent.getByRole('button', { name: '重试打开note-a.txt', exact: true }).locator('..');
  await expect(missingRow).toHaveAttribute('data-missing', 'true');
  await expect(recent.getByText('最近文件已移动')).toBeVisible();
  await expect(recent.getByRole('button', { name: '重新选择', exact: true })).toBeVisible();

  await page.evaluate(() => {
    (Reflect.get(window, 'recentFixture') as { select: (id: string) => void }).select('b');
  });
  await recent.getByRole('button', { name: '重新选择', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('repaired-b.txt');
  await expect(recent.getByRole('button', { name: '打开repaired-b.txt', exact: true })).toBeVisible();
  await expect(recent.getByRole('button', { name: '打开note-a.txt', exact: true })).toHaveCount(0);
  const repairedProfile = await page.evaluate(() =>
    (Reflect.get(window, 'recentFixture') as {
      get: () => { settings: Record<string, unknown> };
    }).get());
  expect(JSON.stringify(repairedProfile.settings.recentHistoryItems)).not.toContain('note-a.txt');
  expect(JSON.stringify(repairedProfile.settings.recentHistoryItems)).toContain('repaired-b.txt');

  await recent.getByRole('button', { name: '清空', exact: true }).click();
  await recent.getByRole('button', { name: '确认清空最近记录', exact: true }).click();
  await expect(recent.locator('[data-recent-kind]')).toHaveCount(0);
  let fixture = await page.evaluate(() =>
    (Reflect.get(window, 'recentFixture') as {
      get: () => { settings: Record<string, unknown> };
    }).get());
  expect(fixture.settings.recentHistoryItems).toEqual({ schemaVersion: 1, entries: [] });

  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('checkbox', { name: '记录最近打开', exact: true }).uncheck();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('设置已保存');
  await settings.getByRole('button', { name: '取消并还原预览', exact: true }).click();
  await expect(recent.getByRole('note')).toContainText('最近记录已关闭');

  const savesBeforePrivateOpen = await page.evaluate(() =>
    (Reflect.get(window, 'recentFixture') as { saves: () => number }).saves());
  await page.evaluate(() => {
    (Reflect.get(window, 'recentFixture') as { select: (id: string) => void }).select('c');
  });
  await openFile.click();
  await expect(page.locator('.cm-content')).toHaveText('private-c.txt');
  expect(await page.evaluate(() =>
    (Reflect.get(window, 'recentFixture') as { saves: () => number }).saves())).toBe(savesBeforePrivateOpen);
  fixture = await page.evaluate(() =>
    (Reflect.get(window, 'recentFixture') as {
      get: () => { settings: Record<string, unknown> };
    }).get());
  expect(fixture.settings).toMatchObject({
    recentHistoryEnabled: false,
    recentHistoryItems: { schemaVersion: 1, entries: [] },
  });
});

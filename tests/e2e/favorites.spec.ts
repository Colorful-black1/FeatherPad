import { menuItem, sidebarSection } from '../ui-actions';
import { expect, test } from './test-fixture';

test('Web mock favorites persist names and ordering independently of disabled history, repair missing entries and retain damaged data', async ({ page }) => {
  await page.addInitScript(() => {
    type Ref = { grantId: string; relativePath: string };
    const root: Ref = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const file: Ref = { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' };
    const metadata = { displayPath: 'E:/favorites/long-folder-name-for-readability/another-folder/file.txt', sizeBytes: 7, modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: 'a'.repeat(64) };
    let version = 1;
    let settings = JSON.parse(localStorage.getItem('favorites-test-settings') ?? '{"recentHistoryEnabled":false}') as Record<string, unknown>;
    let fail = false;
    Reflect.set(window, 'favoritesFixture', { fail: () => { fail = true; }, settings: () => settings });
    const profile = () => ({ schemaVersion: 1, version, revision: String(version % 10).repeat(64), settings, warning: null, recoveryCopies: [] });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok(profile());
        case 'save_settings': settings = args.settings as Record<string, unknown>; version++; localStorage.setItem('favorites-test-settings', JSON.stringify(settings)); return ok({ version, revision: profile().revision });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_files': return ok({ grants: [file], failures: [] });
        case 'choose_folder': return ok({ grant: root, displayName: 'fav-root' });
        case 'inspect_workspace_root': return ok({ ref: root, displayName: 'fav-root', displayPath: 'E:/favorites', canonicalIdentity: 'b'.repeat(64) });
        case 'list_directory': return ok({ items: [], nextCursor: null });
        case 'open_document': {
          if (fail) { fail = false; return { ok: false, error: { code: 'NOT_FOUND', message: 'Controlled missing source', retryable: false } }; }
          return ok({ documentId: '33333333-3333-4333-8333-333333333333', ref: file, canonicalIdentity: 'c'.repeat(64), metadata,
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
            content: { kind: 'text', text: 'content', newlineMap: { documentVersion: 0, endings: [] } } });
        }
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'favorites' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await sidebarSection(page, '收藏');
  const panel = page.getByRole('region', { name: '收藏', exact: true });
  await panel.getByRole('button', { name: '收藏当前文件', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  const favorite = panel.locator('.favorite-open');
  await expect(favorite).toHaveAttribute('title', /long-folder-name-for-readability/);
  const width = await favorite.evaluate(element => ({ available: element.clientWidth, content: element.scrollWidth }));
  expect(width.content).toBeLessThanOrEqual(width.available);
  await page.screenshot({ path: test.info().outputPath('favorite-long-path.png') });
  await panel.getByRole('button', { name: '重命名收藏 file.txt', exact: true }).click();
  await panel.getByRole('textbox', { name: '收藏名称 file.txt', exact: true }).fill('我的文档');
  await panel.getByRole('button', { name: '确定', exact: true }).click();
  await (await menuItem(page, '打开文件夹')).click();
  await panel.getByRole('button', { name: '收藏当前文件夹', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('button', { name: '上移收藏 fav-root', exact: true }).click();
  await expect(panel.getByRole('listitem').first()).toContainText('fav-root');
  const stored = await page.evaluate(() => (Reflect.get(window, 'favoritesFixture') as { settings: () => Record<string, unknown> }).settings());
  expect(stored.recentHistoryItems).toBeUndefined();
  await page.reload(); await sidebarSection(page, '收藏');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').last()).toContainText('我的文档');
  await expect(panel.getByRole('listitem').last()).toContainText('授权失效');
  await panel.getByRole('listitem').last().getByRole('button', { name: '重新选择', exact: true }).click();
  await expect(panel.getByRole('button', { name: '我的文档', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: '我的文档', exact: true })).toHaveAttribute('aria-description', /long-folder-name-for-readability/);
  await panel.getByRole('button', { name: '移除收藏 我的文档', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await panel.getByRole('button', { name: '清空', exact: true }).click();
  await expect(panel.getByRole('group', { name: '确认清空收藏' })).toContainText('最近记录和恢复正文都不会改变');
  await panel.getByRole('button', { name: '确认清空收藏', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('favorites-test-settings', '{"workspaceFavorites":{"schemaVersion":99,"entries":[]}}'));
  await page.reload(); await sidebarSection(page, '收藏');
  await expect(panel.getByRole('alert')).toContainText('原记录已保留');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('favorites-test-settings')!).workspaceFavorites.schemaVersion)).toBe(99);
});

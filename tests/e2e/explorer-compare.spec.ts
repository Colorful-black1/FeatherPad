import { menuItem } from '../ui-actions';
import { expect, test } from './test-fixture';

test('Web mock: compare a workspace file with a file chosen from disk in a tab', async ({ page }) => {
  await page.addInitScript(() => {
    const grant = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    const chosen = { grantId: '22222222-2222-4222-8222-222222222222', relativePath: '' };
    let version = 1;
    let chooserCalls = 0;
    const entry = (name: string) => ({ id: name, name, kind: 'file',
      ref: { ...grant, relativePath: name }, revision: 'a'.repeat(64), isHidden: false, isReadOnly: false,
      modifiedAt: '2026-11-09T00:00:00Z', createdAt: '2026-11-09T00:00:00Z' });
    const items = [entry('a.txt'), entry('b.txt')];
    const snapshot = (reference: { grantId?: string }) => ({
      text: reference.grantId === chosen.grantId ? 'shared\nnew\n' : 'shared\nold\n',
      metadata: { displayPath: reference.grantId === chosen.grantId ? 'E:/chosen/other.txt' : 'E:/project/a.txt',
        sizeBytes: 12, modifiedAt: '2026-11-09T00:00:00Z', isReadOnly: false,
        diskRevision: (reference.grantId === chosen.grantId ? 'b' : 'a').repeat(64) },
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
    });
    Reflect.set(window, 'compareChooserCalls', () => chooserCalls);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version, revision: 'a'.repeat(64), settings: {}, warning: null });
        case 'save_settings': version += 1; return ok({ version, revision: 'b'.repeat(64) });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant, displayName: 'compare-project' });
        case 'inspect_workspace_root': return ok({ ref: grant, displayName: 'compare-project',
          displayPath: 'E:/project', canonicalIdentity: 'b'.repeat(64) });
        case 'list_directory': return ok({ items, nextCursor: null });
        case 'choose_files':
          chooserCalls += 1;
          return ok({ grants: [chosen], failures: [] });
        case 'read_comparison_snapshot': {
          const reference = args.ref as { grantId?: string } | undefined;
          return ok(snapshot(reference ?? {}));
        }
        case 'start_watch': return ok({ watchId: 'compare-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected compare fixture command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await (await menuItem(page, '打开文件夹')).click();
  const source = page.getByRole('treeitem', { name: 'a.txt', exact: true });
  await source.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '与文件比较…', exact: true }).click();
  expect(await page.evaluate(() => {
    const calls = Reflect.get(window, 'compareChooserCalls') as () => number;
    return calls();
  })).toBe(1);

  const tab = page.getByRole('tab', { name: '对比 a.txt', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const comparison = page.getByRole('region', { name: '双文件对比', exact: true });
  await expect(comparison.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 1');
  await expect(comparison.getByRole('heading', { name: /a\.txt（磁盘/ })).toBeVisible();
  await expect(comparison.getByRole('heading', { name: /other\.txt（磁盘/ })).toBeVisible();
  await expect(page.getByRole('tablist', { name: '打开的文档', exact: true }).getByRole('tab')).toHaveCount(1);

  await page.keyboard.press('Control+n');
  const documentTab = page.getByRole('tab', { name: '无标题 1', exact: true });
  await expect(documentTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: '双文件对比', exact: true })).toHaveCount(0);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(comparison.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 1');

  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tablist', { name: '打开的文档', exact: true }).getByRole('tab')).toHaveCount(1);
  await expect(documentTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: '双文件对比', exact: true })).toHaveCount(0);
});

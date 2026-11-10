import { expect, test } from './test-fixture';
import { menuItem } from '../ui-actions';

test('keeps explorer scroll position when a window-focus refresh revalidates the tree', async ({ page }) => {
  await page.addInitScript(() => {
    const grant = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    let version = 1;
    let directoryCalls = 0;
    const settings: Record<string, unknown> = {};
    const entry = (name: string) => ({ id: name, name, kind: 'file',
      ref: { ...grant, relativePath: name }, revision: 'a'.repeat(64), isHidden: false, isReadOnly: false });
    const files = Array.from({ length: 80 }, (_, index) => entry(`file-${String(index + 1).padStart(2, '0')}.txt`));
    const metadata = { displayPath: 'E:/FEATHERPAD/file-80.txt', sizeBytes: 4, modifiedAt: '2026-11-09T00:00:00Z',
      isReadOnly: false, diskRevision: 'a'.repeat(64) };
    Reflect.set(window, 'explorerDirectoryCalls', () => directoryCalls);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version, revision: 'a'.repeat(64), settings, warning: null });
        case 'save_settings': version += 1; return ok({ version, revision: 'b'.repeat(64) });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant, displayName: 'FEATHERPAD' });
        case 'inspect_workspace_root': return ok({ ref: grant, displayName: 'FEATHERPAD', displayPath: 'E:/FEATHERPAD', canonicalIdentity: 'b'.repeat(64) });
        case 'list_directory': {
          directoryCalls += 1;
          if (directoryCalls > 1) await new Promise(resolve => setTimeout(resolve, 120));
          return ok({ items: files, nextCursor: null });
        }
        case 'open_document': return ok({ documentId: '22222222-2222-4222-8222-222222222222', ref: args.ref, metadata,
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
          content: { kind: 'text', text: 'scroll', newlineMap: { documentVersion: 0, endings: ['lf'] } } });
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'scroll-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  await (await menuItem(page, '打开文件夹')).click();
  const scroller = page.locator('#sidebar-explorer .explorer-scroll');
  await expect(page.getByRole('treeitem', { name: 'file-80.txt', exact: true })).toBeAttached();
  const before = await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(0);
  await page.getByRole('treeitem', { name: 'file-80.txt', exact: true }).click();
  await page.waitForTimeout(50);
  const selected = await scroller.evaluate(element => element.scrollTop);
  expect(selected).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(30);
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(selected);
  await page.waitForTimeout(140);
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(selected);
  await expect(page.getByRole('treeitem', { name: 'file-80.txt', exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const calls = Reflect.get(window, 'explorerDirectoryCalls') as () => number;
    return calls();
  })).toBeGreaterThan(1);
});

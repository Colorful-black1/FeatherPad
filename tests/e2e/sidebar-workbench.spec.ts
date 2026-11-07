import { expect, test } from './test-fixture';
import { menuItem } from '../ui-actions';

const longName = '这是一份用于检查侧栏长文件名显示和省略行为的需求文档.txt';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ longName }) => {
    const grant = { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' };
    let version = 1;
    let userSettings: Record<string, unknown> = {};
    const entry = (name: string, relativePath: string, kind = 'file') => ({ id: relativePath, name, kind,
      ref: { ...grant, relativePath }, revision: 'a'.repeat(64), isHidden: false, isReadOnly: false });
    const metadata = { displayPath: `E:/FEATHERPAD/${longName}`, sizeBytes: 15, modifiedAt: '2026-11-05T00:00:00Z',
      isReadOnly: false, diskRevision: 'a'.repeat(64) };
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version, revision: String(version % 10).repeat(64), settings: userSettings, warning: null, recoveryCopies: [] });
        case 'save_settings': userSettings = args.settings as Record<string, unknown>; version++;
          return ok({ version, revision: String(version % 10).repeat(64) });
        case 'list_font_families': return ok({ families: ['Consolas'], truncated: false });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant, displayName: 'FEATHERPAD' });
        case 'inspect_workspace_root': return ok({ ref: grant, displayName: 'FEATHERPAD', displayPath: 'E:/FEATHERPAD', canonicalIdentity: 'b'.repeat(64) });
        case 'list_directory': {
          const ref = args.ref as { relativePath: string };
          return ok({ items: ref.relativePath ? [entry('README.md', 'docs/README.md')]
            : [entry('docs', 'docs', 'directory'), entry('src', 'src', 'directory'), entry(longName, longName)], nextCursor: null });
        }
        case 'open_document': return ok({ documentId: '22222222-2222-4222-8222-222222222222', ref: args.ref, metadata,
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
          content: { kind: 'text', text: 'FeatherPad\nSidebar workspace', newlineMap: { documentVersion: 0, endings: ['lf'] } } });
        case 'stat_document': return ok(metadata);
        case 'start_watch': return ok({ watchId: 'sidebar-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected command ${command}`);
      }
    } });
  }, { longName });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  await (await menuItem(page, '打开文件夹')).click();
  await expect(page.getByRole('tree', { name: 'FEATHERPAD 文件树' })).toBeVisible();
});

test('resources show a clean tree and dedicated activities keep their views separate', async ({ page }) => {
  const sidebar = page.getByRole('complementary', { name: '资源管理器', exact: true });
  await expect(sidebar.getByText('包含文件规则（每行一条）', { exact: true })).not.toBeVisible();
  await expect(sidebar.locator('.explorer-help')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: '打开文件夹…', exact: true })).not.toBeVisible();
  await expect(sidebar.locator('.sidebar-view:visible')).toHaveCount(1);
  const row = page.getByRole('treeitem', { name: longName, exact: true });
  await expect(row).toHaveAttribute('title', longName);
  const sizes = await row.locator('.tree-name').evaluate(element => ({ visible: element.clientWidth, text: element.scrollWidth,
    whitespace: getComputedStyle(element).whiteSpace }));
  expect(sizes.text).toBeGreaterThan(sizes.visible);
  expect(sizes.whitespace).toBe('nowrap');
  const root = sidebar.locator('.tree-root-label');
  await root.click();
  await expect(row).not.toBeVisible();
  await root.press('Enter');
  await expect(row).toBeVisible();
  await row.dblclick();
  await page.getByRole('button', { name: '显示最近打开', exact: true }).click();
  await expect(sidebar.locator('#sidebar-recent')).toBeVisible();
  await expect(sidebar.locator('#sidebar-explorer')).not.toBeVisible();
  await expect(sidebar.getByRole('button', { name: `打开${longName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '显示收藏', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: '收藏当前文件', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换资源管理器', exact: true }).click();
  await expect(row).toBeVisible();
  await sidebar.getByText('已打开的编辑器', { exact: false }).click();
  await expect(sidebar.getByRole('button', { name: '关闭编辑器 ' + longName, exact: true })).toBeVisible();
  await expect(page.locator('.document-view .cm-content')).toContainText('Sidebar workspace');
});

test('file filters open in a separate form and retain explicit validation', async ({ page }) => {
  await page.getByRole('button', { name: '文件筛选', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '文件筛选', exact: true });
  const include = dialog.getByRole('textbox', { name: '包含 glob', exact: true });
  const exclude = dialog.getByRole('textbox', { name: '排除 glob', exact: true });
  const includeBox = await include.boundingBox();
  const excludeBox = await exclude.boundingBox();
  expect(excludeBox!.y).toBeGreaterThan(includeBox!.y + includeBox!.height);
  await include.fill('x'.repeat(1025));
  await include.press('Tab');
  await expect(dialog.getByRole('alert')).toContainText('未应用');
  await dialog.getByRole('button', { name: '还原已应用规则' }).click();
  await expect(include).toHaveValue('');
  await dialog.getByRole('checkbox', { name: '显示隐藏项' }).check();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '文件筛选', exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('resource-view.png') });
});

test('search uses the sidebar, preserves its draft and leaves the editor available', async ({ page }) => {
  await page.getByRole('treeitem', { name: longName, exact: true }).dblclick();
  await page.keyboard.press('Control+Shift+f');
  const search = page.getByRole('region', { name: '在文件和文件夹中查找', exact: true });
  await expect(search).toBeVisible();
  const input = search.getByRole('searchbox', { name: '搜索内容', exact: true });
  await input.fill('kept query');
  await page.getByRole('button', { name: '显示最近打开', exact: true }).click();
  await expect(search).not.toBeVisible();
  await page.getByRole('button', { name: '显示搜索', exact: true }).click();
  await expect(input).toHaveValue('kept query');
  await expect(input).toBeFocused();
  await expect(page.locator('.document-view .cm-content')).toBeVisible();
});

for (const width of [220, 280, 400]) {
  test(`sidebar width ${width} stays within its bounds with long names and 200% zoom`, async ({ page }) => {
    await page.getByRole('treeitem', { name: longName, exact: true }).dblclick();
    const sidebar = page.getByRole('complementary', { name: '资源管理器', exact: true });
    const divider = page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
    await divider.focus();
    await divider.press('Home');
    for (let value = 220; value < width; value += 16) await divider.press('ArrowRight');
    const overflow = () => sidebar.evaluate(element => element.scrollWidth > element.clientWidth);
    expect(await overflow()).toBe(false);
    await expect(sidebar.locator('.explorer-titlebar')).toBeInViewport();
    await page.locator('.document-view .cm-content').focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`sidebar-${width}-light.png`) });
    await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    expect(await overflow()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '资源管理器更多操作', exact: true })).toBeInViewport();
    for (const action of await page.locator('.activity-rail button').all()) await expect(action).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: test.info().outputPath(`sidebar-${width}-dark-200.png`) });
  });
}

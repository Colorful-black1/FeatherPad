import { menuItem, sidebarSection } from '../ui-actions';
import { expect, test } from './test-fixture';

test('multiple roots keep dirty buffers while reordering, switching trees and revoking a root', async ({ page }) => {
  await page.addInitScript(() => {
    let selection = 0;
    const roots = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const documentId = '33333333-3333-4333-8333-333333333333';
    const independent = '44444444-4444-4444-8444-444444444444';
    const meta = { displayPath: 'E:/one/notes/a.txt', sizeBytes: 8, modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: 'a'.repeat(64) };
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ ok: true, value });
      const root = args.root as { grantId: string } | undefined;
      switch (command) {
        case 'choose_folder': return ok({ grant: { grantId: roots[selection++ % 2], relativePath: '' }, displayName: 'notes' });
        case 'inspect_workspace_root': return ok({ ref: root, displayName: 'notes', displayPath: root?.grantId === roots[0] ? 'E:/one/notes' : 'E:/two/notes',
          canonicalIdentity: (root?.grantId === roots[0] ? 'a' : 'b').repeat(64) });
        case 'list_directory': {
          const ref = args.ref as { grantId: string }; const name = ref.grantId === roots[0] ? 'a.txt' : 'b.txt';
          return ok({ items: [{ id: name, ref: { ...ref, relativePath: name }, name, kind: 'file', isHidden: false, isReadOnly: false, revision: 'a'.repeat(64) }], nextCursor: null });
        }
        case 'open_document': return ok({ documentId, ref: { grantId: roots[0], relativePath: 'a.txt' }, metadata: meta,
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
          content: { kind: 'text', text: 'original', newlineMap: { documentVersion: 0, endings: [] } } });
        case 'release_workspace_root': return ok({ renamedDocuments: [{ documentId, ref: { grantId: independent, relativePath: '' }, displayPath: meta.displayPath }] });
        case 'stat_document': return ok(meta);
        case 'start_watch': return ok({ watchId: 'multi-root' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected business command ${command}`);
      }
    } });
  });
  await page.goto('/'); await (await menuItem(page, '打开文件夹')).click();
  await page.getByRole('treeitem', { name: 'a.txt', exact: true }).dblclick();
  const editor = page.locator('.document-view .cm-content');
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' draft');
  await (await menuItem(page, '添加文件夹…')).click();
  await sidebarSection(page, '工作区管理');
  const list = page.getByRole('region', { name: '工作区根', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('treeitem', { name: 'b.txt', exact: true })).toBeVisible();
  const first = list.getByRole('listitem').filter({ hasText: 'E:/one/notes' });
  await first.getByRole('button', { name: '下移根 notes', exact: true }).click();
  await expect(list.getByRole('listitem').last()).toContainText('E:/one/notes');
  await first.getByRole('button', { pressed: false }).first().click();
  await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
  await first.getByRole('button', { name: '移除根 notes', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(editor).toHaveText('original draft');
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /有未保存修改/);
});

test('Web mock lazily pages one root and keeps empty, denied, hidden and current-file states visible', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; request: Record<string, unknown> }[] = [];
    Reflect.set(window, 'workspaceCalls', calls);
    const grant = { grantId: 'workspace-grant', relativePath: '' };
    const entry = (name: string, relativePath: string, kind: string, isHidden = false) => ({
      id: relativePath, ref: { grantId: grant.grantId, relativePath }, name, kind, isHidden, isReadOnly: false,
      revision: 'a'.repeat(64),
    });
    const folderEntries = [entry('nested.txt', 'folder/nested.txt', 'file')];
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, request: Record<string, unknown>) => {
        calls.push({ command, request });
        if (command === 'choose_folder') return {
          ok: true,
          value: { grant, displayName: 'controlled-project' },
        };
        if (command === 'inspect_workspace_root') return { ok: true, value: { ref: grant, displayName: 'controlled-project', displayPath: 'E:/controlled-project', canonicalIdentity: 'b'.repeat(64) } };
        if (command === 'list_directory') {
          const ref = request.ref as { relativePath: string };
          const showHidden = request.showHidden === true;
          if (ref.relativePath === '' && request.cursor === 'root-next') return {
            ok: true,
            value: { items: [entry('extra.txt', 'extra.txt', 'file')], nextCursor: null },
          };
          if (ref.relativePath === '' && showHidden) return {
            ok: true,
            value: {
              items: [
                entry('folder', 'folder', 'directory'),
                entry('.hidden', '.hidden', 'file', true),
              ],
              nextCursor: null,
            },
          };
          if (ref.relativePath === '') return {
            ok: true,
            value: {
              items: [
                entry('folder', 'folder', 'directory'),
                entry('empty', 'empty', 'directory'),
                entry('denied', 'denied', 'directory'),
              ],
              nextCursor: 'root-next',
            },
          };
          if (ref.relativePath === 'folder') return {
            ok: true,
            value: { items: [...folderEntries], nextCursor: null },
          };
          if (ref.relativePath === 'empty') return {
            ok: true,
            value: { items: [], nextCursor: null },
          };
          if (ref.relativePath === 'denied') return {
            ok: false,
            error: { code: 'PERMISSION_DENIED', message: 'controlled denied directory', retryable: true },
          };
        }
        if (command === 'create_entry') {
          const parent = request.parent as { grantId: string; relativePath: string };
          const relativePath = parent.relativePath
            ? `${parent.relativePath}/${String(request.name)}` : String(request.name);
          const created = entry(String(request.name), relativePath, String(request.kind));
          if (parent.relativePath === 'folder') folderEntries.push(created);
          return {
            ok: true,
            value: created,
          };
        }
        if (command === 'rename_entry') {
          const ref = request.ref as { grantId: string; relativePath: string };
          const parent = ref.relativePath.split('/').slice(0, -1).join('/');
          const relativePath = parent ? `${parent}/${String(request.newName)}` : String(request.newName);
          const renamed = entry(String(request.newName), relativePath, 'file');
          const index = folderEntries.findIndex(item => item.ref.relativePath === ref.relativePath);
          if (index >= 0) folderEntries[index] = renamed;
          return {
            ok: true,
            value: {
              entry: renamed,
              renamedDocuments: [{
                documentId: `workspace-${ref.relativePath.replaceAll('/', '-')}`, ref: renamed.ref,
                displayPath: relativePath,
              }],
            },
          };
        }
        if (command === 'open_document') {
          const ref = request.ref as { grantId: string; relativePath: string };
          const documentId = `workspace-${ref.relativePath.replaceAll('/', '-')}`;
          return {
            ok: true,
            value: {
              documentId, ref,
              metadata: {
                displayPath: ref.relativePath, sizeBytes: 6, modifiedAt: '2026-11-01T00:00:00Z',
                isReadOnly: false, diskRevision: 'workspace-revision',
              },
              format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
              warnings: [], mode: 'normal',
              content: { kind: 'text', text: 'nested', newlineMap: { documentVersion: 0, endings: [] } },
            },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件夹' }).click();
  const tree = page.getByRole('tree', { name: 'controlled-project 文件树' });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /folder/ })).toBeVisible();
  let calls = await page.evaluate(() => Reflect.get(window, 'workspaceCalls') as { command: string; request: { ref?: { relativePath: string } } }[]);
  expect(calls.filter(call => call.command === 'list_directory')).toHaveLength(1);
  await tree.getByRole('button', { name: '加载更多' }).click();
  await expect(tree.getByRole('treeitem', { name: 'extra.txt' })).toBeVisible();

  await tree.getByRole('treeitem', { name: /folder/ }).click();
  await expect(tree.getByRole('treeitem', { name: 'nested.txt' })).toBeVisible();
  calls = await page.evaluate(() => Reflect.get(window, 'workspaceCalls') as typeof calls);
  expect(calls.some(call => call.command === 'list_directory' && call.request.ref?.relativePath === 'folder')).toBe(true);

  await tree.getByRole('treeitem', { name: 'nested.txt' }).click();
  await expect(page.locator('.cm-content')).toHaveText('nested');
  await expect(page.getByRole('button', { name: '定位当前文件' })).toBeEnabled();

  await tree.getByRole('treeitem', { name: /folder/ }).click();
  await expect(tree.getByRole('treeitem', { name: 'nested.txt' })).toHaveCount(0);
  await page.getByRole('button', { name: '定位当前文件' }).click();
  await expect(tree.getByRole('treeitem', { name: 'nested.txt' })).toHaveAttribute('aria-current', 'page');

  await tree.getByRole('treeitem', { name: /empty/ }).click();
  await expect(tree.getByText('此文件夹为空')).toBeVisible();
  await tree.getByRole('treeitem', { name: /denied/ }).click();
  await expect(tree.getByRole('alert')).toContainText('controlled denied directory');
  await expect(tree.getByRole('button', { name: '重试' })).toBeVisible();

  await page.getByRole('checkbox', { name: '显示隐藏项' }).check();
  await expect(tree.getByRole('treeitem', { name: /\.hidden/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /denied/ })).toHaveCount(0);

  await tree.getByRole('treeitem', { name: /folder/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /\.hidden/ })).toBeFocused();

  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' edited');
  await expect(page.getByLabel('有未保存修改', { exact: true })).toBeVisible();
  await (await menuItem(page, '打开文件夹')).click();
  await expect(tree).toBeVisible();
  await expect(editor).toHaveText('nested edited');
  await expect(page.getByLabel('有未保存修改', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '定位当前文件' }).click();

  const sourceRow = tree.getByRole('treeitem', { name: 'nested.txt', exact: true });
  const targetRoot = page.locator('.tree-root-label');
  await expect(targetRoot).not.toHaveAttribute('data-drag-over', 'true');
  const nativeDialogs: string[] = [];
  page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  await sourceRow.dragTo(targetRoot);
  const moveDialog = page.getByRole('dialog', { name: '移动文件', exact: true });
  await expect(moveDialog).toBeVisible();
  await expect(moveDialog).toContainText('folder/nested.txt');
  await expect(moveDialog).toContainText('目标文件夹');
  await expect(moveDialog.getByRole('button', { name: '取消移动', exact: true })).toBeFocused();
  await moveDialog.getByRole('button', { name: '取消移动', exact: true }).click();
  await expect(moveDialog).not.toBeVisible();
  await expect(sourceRow).toBeVisible();
  expect(nativeDialogs).toEqual([]);
  await expect(targetRoot).not.toHaveAttribute('data-drag-over', 'true');
  await sourceRow.focus();
  await sourceRow.press('Shift+F10');
  const actions = page.getByRole('menu', { name: '资源管理器操作', exact: true });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole('menuitem', { name: '重命名…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sourceRow).toBeFocused();

  await page.getByRole('button', { name: '重命名选中项' }).click();
  const renameInput = page.getByRole('textbox', { name: '重命名' });
  await expect(renameInput).toHaveValue('nested.txt');
  await renameInput.fill('中文.txt');
  await renameInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  await expect(renameInput).toBeVisible();
  await expect(renameInput).toHaveValue('中文.txt');
  await renameInput.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true });
  await expect(renameInput).toBeVisible();
  await renameInput.fill('renamed.txt');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /renamed\.txt 有未保存修改/ })).toBeVisible();
  await expect(page.getByLabel('有未保存修改', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  const createInput = page.getByRole('textbox', { name: '新建文件名称' });
  await createInput.fill('中文文件.txt');
  await createInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  await expect(createInput).toBeVisible();
  await createInput.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  await expect(createInput).toHaveValue('中文文件.txt');
  await createInput.fill('CON');
  await createInput.press('Enter');
  await expect(page.locator('.tree-input-error')).toContainText('保留设备名');
  await createInput.fill('树内新建.txt');
  await createInput.press('Enter');
  await expect(tree.getByRole('treeitem', { name: '树内新建.txt', exact: true })).toBeVisible();
  calls = await page.evaluate(() => Reflect.get(window, 'workspaceCalls') as typeof calls);
  expect(calls.some(call => call.command === 'open_document'
    && call.request.ref?.relativePath === 'folder/树内新建.txt')).toBe(true);
  await expect(page.getByRole('tab', { name: '树内新建.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
});

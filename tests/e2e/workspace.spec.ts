import { expect, test } from './test-fixture';

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
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(tree).toBeVisible();
  await expect(editor).toHaveText('nested edited');
  await expect(page.getByLabel('有未保存修改', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '定位当前文件' }).click();

  await page.getByRole('button', { name: '重命名选中项' }).click();
  const renameInput = page.getByRole('textbox', { name: '重命名' });
  await expect(renameInput).toHaveValue('nested.txt');
  await renameInput.fill('renamed.txt');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /renamed\.txt 有未保存修改/ })).toBeVisible();
  await expect(page.getByLabel('有未保存修改', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  const createInput = page.getByRole('textbox', { name: '新建文件名称' });
  await createInput.fill('CON');
  await createInput.press('Enter');
  await expect(page.getByRole('alert')).toContainText('保留设备名');
  await createInput.fill('树内新建.txt');
  await createInput.press('Enter');
  await expect(tree.getByRole('treeitem', { name: '树内新建.txt', exact: true })).toBeVisible();
  calls = await page.evaluate(() => Reflect.get(window, 'workspaceCalls') as typeof calls);
  expect(calls.some(call => call.command === 'open_document'
    && call.request.ref?.relativePath === 'folder/树内新建.txt')).toBe(true);
  await expect(page.getByRole('tab', { name: '树内新建.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
});

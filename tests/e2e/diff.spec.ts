import { menuItem } from '../ui-actions';
import { expect, test } from './test-fixture';

test('two opened buffers compare in readonly worker snapshots with navigation and optional whitespace ignoring', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('same\nleft\nsame2\nend');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const source = 'same\nright\nsame2\nend ';
  await page.locator('.cm-content').focus(); await page.keyboard.insertText(source);
  await (await menuItem(page, '比较文件…')).click();
  const dialog = page.getByRole('dialog', { name: '双文件对比', exact: true });
  await dialog.getByRole('combobox', { name: '左侧比较来源', exact: true }).selectOption({ label: '无标题 1（未保存）' });
  await dialog.getByRole('combobox', { name: '右侧比较来源', exact: true }).selectOption({ label: '无标题 2（未保存）' });
  await dialog.getByRole('button', { name: '生成对比', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 2');
  await expect(dialog.locator('.cm-content[contenteditable="false"]')).toHaveCount(2);
  await dialog.getByRole('button', { name: '下一处差异', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 2 / 2');
  await dialog.getByRole('checkbox', { name: '忽略空格/Tab（仅比较）', exact: true }).check();
  await dialog.getByRole('button', { name: '生成对比', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 1');
  await dialog.getByRole('combobox', { name: '右侧比较来源', exact: true }).selectOption({ label: '无标题 1（未保存）' });
  await dialog.getByRole('button', { name: '生成对比', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('两份快照一致');
  await dialog.getByRole('button', { name: '关闭对比', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(source.split('\n'));
});

test('Web mock: comparing two disk snapshots works from an empty editor and creates no live document', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let pick = 0;
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null, settings: {}, warning: null, recoveryCopies: [] });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_files': return ok({ grants: [{ grantId: `disk-${++pick}`, relativePath: '' }], failures: [] });
        case 'read_comparison_snapshot': {
          const reference = args.ref;
          if (!reference || typeof reference !== 'object') throw new Error('Missing FileRef');
          const index = Reflect.get(reference, 'grantId') === 'disk-1' ? 1 : 2;
          return ok({ text: index === 1 ? 'one\nold\n' : 'one\nnew\n',
            metadata: { displayPath: `E:\\fixtures\\disk-${index}.txt`, sizeBytes: 8, modifiedAt: '2026-11-03T00:00:00Z', isReadOnly: false, diskRevision: String(index).repeat(64) },
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' } });
        }
        case 'start_watch': return ok({ watchId: 'diff-watch' });
        case 'stop_watch': return ok({ stopped: true });
        default: throw new Error(`Unexpected diff fixture command ${command}`);
      }
    } });
  });
  await page.goto('/'); await (await menuItem(page, '比较文件…')).click();
  const dialog = page.getByRole('dialog', { name: '双文件对比', exact: true });
  await dialog.getByRole('button', { name: '选择左侧磁盘文件…', exact: true }).click();
  await dialog.getByRole('button', { name: '选择右侧磁盘文件…', exact: true }).click();
  await dialog.getByRole('button', { name: '生成对比', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 1');
  await expect(dialog.getByRole('heading', { name: /disk-1\.txt（磁盘/ })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /disk-2\.txt（磁盘/ })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭对比', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '打开的文档', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建文本', exact: true })).toBeVisible();
});

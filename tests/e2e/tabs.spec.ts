import { menuItem } from '../ui-actions';
import { expect, test, type Page } from './test-fixture';

async function installFiles(page: Page) {
  await page.addInitScript(() => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const texts = new Map(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'large.txt', 'one/note.txt', 'two/note.txt'].map(name => [name, `${name.split('.')[0]} original`]));
    const leases = new Map<string, string>();
    const grant = 'tabs-controlled-grant';
    Reflect.set(window, 'tabCalls', calls);
    Reflect.set(window, 'tabFiles', texts);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      const ref = args.ref as { relativePath: string } | undefined;
      const fault: unknown = Reflect.get(window, 'tabFault');
      const error = (code: string, message: string) => ({ ok: false, error: { code, message, retryable: false } });
      const metadata = (name: string, revision = 'a'.repeat(64)) => ({ displayPath: `E:/controlled/${name}`,
        sizeBytes: new TextEncoder().encode(texts.get(name) ?? '').length, modifiedAt: '2026-11-02T00:00:00Z', isReadOnly: false, diskRevision: revision });
      if (command === 'choose_folder') return { ok: true, value: { grant: { grantId: grant, relativePath: '' }, displayName: 'controlled-tabs' } };
      if (command === 'inspect_workspace_root') return { ok: true, value: { ref: { grantId: grant, relativePath: '' }, displayName: 'controlled-tabs', displayPath: 'E:/controlled-tabs', canonicalIdentity: 'c'.repeat(64) } };
      if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: grant, relativePath: 'a.txt' }], failures: [] } };
      if (command === 'list_directory') {
        const parent = ref?.relativePath ?? '';
        const names = parent ? ['note.txt'] : ['one', 'two', 'a.txt', 'b.txt', 'c.txt', 'd.txt', 'large.txt'];
        return { ok: true, value: { items: names.map(name => ({ id: `${parent}/${name}`, name,
          ref: { grantId: grant, relativePath: parent ? `${parent}/${name}` : name },
          kind: name === 'one' || name === 'two' ? 'directory' : 'file', isHidden: false, isReadOnly: false,
          revision: 'a'.repeat(64) })), nextCursor: null } };
      }
      if (command === 'open_document') {
        const name = ref?.relativePath ?? '';
        const id = leases.get(name) ?? crypto.randomUUID();
        leases.set(name, id);
        const text = texts.get(name) ?? '';
        const large = name === 'large.txt';
        return { ok: true, value: { documentId: id, ref: { grantId: grant, relativePath: name },
          metadata: { ...metadata(name), ...(large ? { sizeBytes: 20 * 1024 * 1024 } : {}) },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: large ? 'large-readonly' : 'normal',
          content: large ? { kind: 'chunked', handleId: `handle-${id}`, totalBytes: 20 * 1024 * 1024,
            initialChunk: { byteStart: 0, byteEnd: 10, firstLine: 1, text: 'chunk head', hasMore: true } }
            : { kind: 'text', text, newlineMap: { documentVersion: 0, endings: Array.from({ length: text.split('\n').length - 1 }, () => 'lf') } } } };
      }
      if (command === 'save_document') {
        if (fault === 'save') return error('DISK_FULL', '受控保存失败');
        const entry = [...leases].find(([, id]) => id === args.documentId);
        if (!entry) return error('NOT_FOUND', 'Controlled lease not found');
        texts.set(entry[0], String(args.text));
        return { ok: true, value: { documentVersion: args.documentVersion, diskRevision: 'b'.repeat(64),
          savedAt: '2026-11-02T00:00:00Z', sizeBytes: new TextEncoder().encode(String(args.text)).length } };
      }
      if (command === 'save_document_as') {
        if (fault === 'cancel-destination') return error('CANCELLED', 'Path chooser cancelled');
        const name = 'saved-copy.txt';
        texts.set(name, String(args.text));
        leases.set(name, String(args.documentId));
        const value = metadata(name, 'c'.repeat(64));
        return { ok: true, value: { documentId: args.documentId, ref: { grantId: grant, relativePath: name }, metadata: value,
          ack: { documentVersion: args.documentVersion, diskRevision: value.diskRevision, savedAt: value.modifiedAt, sizeBytes: value.sizeBytes } } };
      }
      if (command === 'discard_recovery') return fault === 'discard' ? error('DISK_FULL', '受控恢复存储失败')
        : { ok: true, value: { ...args, discarded: true } };
      if (command === 'release_document') {
        const entry = [...leases].find(([, id]) => id === args.documentId);
        if (entry) leases.delete(entry[0]);
        return fault === 'release-uncertain' ? error('IPC_UNAVAILABLE', '受控关闭回执丢失') : { ok: true, value: { released: !!entry } };
      }
      if (command === 'read_document_chunk') return new Promise(resolve => {
        Reflect.set(window, 'completeTabChunk', () => resolve({ ok: true, value: { byteStart: 10, byteEnd: 20, firstLine: 2, text: 'late chunk', hasMore: true } }));
      });
      throw new Error(`Unexpected controlled command: ${command}`);
    } });
  });
}

async function folder(page: Page) {
  await (await menuItem(page, '打开文件夹')).click();
  await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
}
const fault = (page: Page, value: string | null) => page.evaluate(value => { Reflect.set(window, 'tabFault', value); }, value);
const editor = (page: Page) => page.locator('.cm-content');
const dialog = (page: Page) => page.getByRole('dialog', { name: '关闭文档', exact: true });
async function dirtyFile(page: Page) {
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' dirty');
  await page.keyboard.press('Control+w');
  await expect(dialog(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => { await installFiles(page); await page.goto('/'); });

test('Web mock: file tree opens permanent tabs and tab keyboard navigation', async ({ page }) => {
  await folder(page);
  await page.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).dblclick();
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
  const before = await page.evaluate(() => (Reflect.get(window, 'tabCalls') as unknown[]).length);
  await editor(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' dirty');
  expect(await page.evaluate(() => (Reflect.get(window, 'tabCalls') as unknown[]).length)).toBe(before);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('treeitem', { name: 'c.txt', exact: true }).click();
  await page.getByRole('treeitem', { name: 'd.txt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(4);
  const last = page.getByRole('tab', { name: 'd.txt', exact: true });
  await last.focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(last).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(last).toHaveCount(0);
  await expect(editor(page)).toHaveText('c original');
});

test('Web mock: dirty close defaults to cancel, restores focus and keeps a failed closing save', async ({ page }) => {
  await dirtyFile(page);
  await expect(dialog(page).getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(editor(page)).toHaveText('a original dirty');
  await editor(page).focus();
  await page.keyboard.press('Control+w');
  await fault(page, 'save');
  await dialog(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('受控保存失败');
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveText('a original dirty');
  expect(await page.evaluate(() => (Reflect.get(window, 'tabCalls') as { command: string }[]).filter(call => ['release_document', 'discard_recovery'].includes(call.command)))).toEqual([]);
});

test('Web mock: failed discard retains content, fresh-version retry closes without writing the source at 200 percent zoom', async ({ page }) => {
  await dirtyFile(page);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  for (const button of await dialog(page).getByRole('button').all()) await expect(button).toBeInViewport();
  await fault(page, 'discard');
  await dialog(page).getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('受控恢复存储失败');
  await page.screenshot({ path: test.info().outputPath('close-zoom200.png') });
  await fault(page, null);
  await dialog(page).getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建文本', exact: true })).toBeFocused();
  const versions = await page.evaluate(() => (Reflect.get(window, 'tabCalls') as { command: string; args: { throughVersion: number } }[])
    .filter(call => call.command === 'discard_recovery').map(call => call.args.throughVersion));
  expect(versions).toHaveLength(2);
  expect(versions[1]).toBeGreaterThan(versions[0]!);
  expect(await page.evaluate(() => (Reflect.get(window, 'tabFiles') as Map<string, string>).get('a.txt'))).toBe('a original');
});

test('Web mock: cancelling untitled Save As keeps the close dialog and a subsequent save closes the same buffer', async ({ page }) => {
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.keyboard.insertText('未命名正文😀');
  await page.keyboard.press('Control+w');
  await fault(page, 'cancel-destination');
  await dialog(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('保存已取消');
  await fault(page, null);
  await dialog(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  expect(await page.evaluate(() => (Reflect.get(window, 'tabFiles') as Map<string, string>).get('saved-copy.txt'))).toBe('未命名正文😀');
});

test('Web mock: an unknown release keeps a read-only full copy that explicit Save As can bind again', async ({ page }) => {
  await dirtyFile(page);
  await fault(page, 'release-uncertain');
  await dialog(page).getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('受控关闭回执丢失');
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await expect(editor(page)).toHaveText('a original dirty');
  await fault(page, null);
  await (await menuItem(page, '另存为')).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('tab', { name: 'saved-copy.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => (Reflect.get(window, 'tabFiles') as Map<string, string>).get('a.txt'))).toBe('a original');
});

test('Web mock: pin metadata survives reload, explicit close clears it, and duplicate names show parents', async ({ page }) => {
  await folder(page);
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).dblclick();
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.reload();
  await folder(page);
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('button', { name: '关闭 b.txt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.reload();
  await folder(page);
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('treeitem', { name: 'one', exact: true }).click();
  await page.getByRole('treeitem', { name: 'note.txt', exact: true }).dblclick();
  await page.getByRole('treeitem', { name: 'one', exact: true }).click();
  await page.getByRole('treeitem', { name: 'two', exact: true }).click();
  await page.getByRole('treeitem', { name: 'note.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: /note.txt.*controlled\/one/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /note.txt.*controlled\/two/ })).toBeVisible();
});

test('Web mock: a late chunk cannot replace the retained page after an uncertain close', async ({ page }) => {
  await folder(page);
  await page.getByRole('treeitem', { name: 'large.txt', exact: true }).click();
  await page.getByRole('button', { name: '下一块', exact: true }).click();
  await fault(page, 'release-uncertain');
  await page.getByRole('button', { name: '关闭 large.txt，只读', exact: true }).click();
  await expect(page.locator('.notice.error-notice[role="alert"]')).toContainText('受控关闭回执丢失');
  await page.evaluate(() => { (Reflect.get(window, 'completeTabChunk') as () => void)(); });
  await expect(page.getByRole('button', { name: '下一块', exact: true })).toBeDisabled();
  await expect(page.locator('.large-file-text')).toHaveText('chunk head');
});

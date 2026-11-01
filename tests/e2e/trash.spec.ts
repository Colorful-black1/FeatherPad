import { expect, test, type Page } from '@playwright/test';

async function openFixture(page: Page, mode: 'success' | 'failure' | 'uncertain' = 'success') {
  await page.addInitScript(({ mode }) => {
    const grant = { grantId: 'workspace', relativePath: '' };
    const ref = { ...grant, relativePath: 'trash.txt' };
    let exists = true;
    let opened = false;
    let revision = 'a'.repeat(64);
    let identity = 'b'.repeat(64);
    const calls: { command: string; request: Record<string, unknown> }[] = [];
    Reflect.set(window, 'trashCalls', calls);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, request: Record<string, unknown>) => {
        calls.push({ command, request });
        if (command === 'choose_folder') return { ok: true, value: { grant, displayName: 'Controlled trash fixture' } };
        if (command === 'list_directory') return { ok: true, value: { items: exists
          ? [{ id: 'entry', ref, name: 'trash.txt', kind: 'file', isHidden: false, isReadOnly: false, revision }] : [], nextCursor: null } };
        if (command === 'open_document') {
          opened = true;
          return { ok: true, value: { documentId: 'trash-document', ref,
            metadata: { displayPath: 'E:\\controlled\\trash.txt', sizeBytes: 8, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: revision },
            format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
            content: { kind: 'text', text: 'baseline', newlineMap: { documentVersion: 0, endings: [] } } } };
        }
        if (command === 'get_trash_impact') {
          if (request.expectedRevision !== revision) return { ok: false, error: { code: 'CONFLICT', message: 'Controlled stale revision', retryable: false } };
          return { ok: true, value: { ref, displayPath: 'E:\\controlled\\trash.txt', kind: 'file', revision, identity,
            affectedDocuments: opened ? [{ documentId: 'trash-document', displayPath: 'E:\\controlled\\trash.txt', canSnapshot: true }] : [] } };
        }
        if (command === 'save_document') {
          revision = 'c'.repeat(64);
          identity = 'd'.repeat(64);
          return { ok: true, value: { documentVersion: request.documentVersion, diskRevision: revision,
            savedAt: '2026-11-01T00:00:00Z', sizeBytes: String(request.text).length } };
        }
        if (command === 'trash_entry') {
          if (mode === 'failure') return { ok: false, error: { code: 'TRASH_UNAVAILABLE', message: 'Controlled recycle unavailable; source remains', retryable: false } };
          exists = false;
          if (mode === 'uncertain' && calls.filter(call => call.command === command).length === 1) {
            return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'Controlled lost reply', retryable: false } };
          }
          const snapshots = request.snapshots as { documentId: string; documentVersion: number }[];
          return { ok: true, value: { trashed: true, receiptId: request.requestId, missingDocumentIds: request.affectedDocumentIds,
            drafts: snapshots.map(snapshot => ({ documentId: snapshot.documentId, documentVersion: snapshot.documentVersion, receiptId: 'draft-receipt' })) } };
        }
        if (command === 'save_document_as') return { ok: true, value: { documentId: request.documentId, ref: { ...ref, relativePath: 'restored.txt' },
          metadata: { displayPath: 'E:\\controlled\\restored.txt', sizeBytes: String(request.text).length, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'e'.repeat(64) },
          ack: { documentVersion: request.documentVersion, diskRevision: 'e'.repeat(64), savedAt: '2026-11-01T00:00:00Z', sizeBytes: String(request.text).length } } };
        throw new Error(`Unexpected mock command: ${command}`);
      },
    });
  }, { mode });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.getByRole('treeitem', { name: 'trash.txt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' dirty😀');
  await page.getByRole('button', { name: '移至回收站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移至回收站' });
  await expect(dialog).toContainText('1 个有未保存修改');
  return dialog;
}

async function calls(page: Page) {
  return page.evaluate(() => Reflect.get(window, 'trashCalls') as { command: string; request: Record<string, unknown> }[]);
}

test('Web mock: cancel keeps the file; confirmed recycling preserves the buffer and CtrlS saves elsewhere', async ({ page }) => {
  let dialog = await openFixture(page);
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect((await calls(page)).filter(call => call.command === 'trash_entry')).toHaveLength(0);
  await expect(page.getByRole('treeitem', { name: 'trash.txt' })).toBeVisible();
  await page.getByRole('button', { name: '移至回收站', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保留草稿并移至回收站' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'trash.txt' })).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveText('baseline dirty😀');
  await expect(page.getByRole('note')).toContainText('草稿已获得落盘保护');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'restored.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  const requests = await calls(page);
  expect(requests.filter(call => call.command === 'save_document')).toHaveLength(0);
  expect(requests.filter(call => call.command === 'save_document_as')).toHaveLength(1);
});

test('Web mock: recycling failure leaves the tree and dirty buffer intact', async ({ page }) => {
  const dialog = await openFixture(page, 'failure');
  await dialog.getByRole('button', { name: '保留草稿并移至回收站' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Controlled recycle unavailable');
  await expect(page.getByRole('treeitem', { name: 'trash.txt', includeHidden: true })).toHaveCount(1);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('baseline dirty😀');
  await expect(page.getByRole('tab')).toHaveAccessibleName('trash.txt 有未保存修改');
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('Web mock: an unknown reply is resolved with the identical captured request', async ({ page }) => {
  const dialog = await openFixture(page, 'uncertain');
  await dialog.getByRole('button', { name: '保留草稿并移至回收站' }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '核对上次结果' }).click();
  await expect(dialog).not.toBeVisible();
  const requests = (await calls(page)).filter(call => call.command === 'trash_entry');
  expect(requests).toHaveLength(2);
  expect(requests[0]?.request).toEqual(requests[1]?.request);
});

test('Web mock: saving refreshes revision and identity before a new confirmation at 200 percent zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1120 });
  const dialog = await openFixture(page);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '保留草稿并移至回收站' })).toBeInViewport();
  await dialog.getByRole('button', { name: '保存修改并重新确认' }).click();
  await expect(dialog).toContainText('0 个有未保存修改');
  expect((await calls(page)).filter(call => call.command === 'trash_entry')).toHaveLength(0);
  await page.screenshot({ path: '.artifacts/T105/trash-web-zoom200.png' });
  await dialog.getByRole('button', { name: '移至回收站', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const request = (await calls(page)).find(call => call.command === 'trash_entry')?.request;
  expect(request?.expectedRevision).toBe('c'.repeat(64));
  expect(request?.expectedIdentity).toBe('d'.repeat(64));
});

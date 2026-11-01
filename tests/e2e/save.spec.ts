import { expect, test } from '@playwright/test';

test('Web mock: delayed save Ack keeps newer input dirty, next save uses its revision', async ({ page }) => {
  await page.addInitScript(() => {
    const saves: { text: string; documentVersion: number; expectedDiskRevision: string }[] = [];
    Reflect.set(window, 'fixtureSaves', saves);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string, args: { text: string; documentVersion: number; expectedDiskRevision: string }) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'fixture', relativePath: '' }] } };
        if (command === 'open_document') return { ok: true, value: {
          documentId: 'fixture-document', ref: { grantId: 'fixture', relativePath: '' },
          metadata: { displayPath: 'save fixture.txt', sizeBytes: 8, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'rev-0' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: 'baseline', newlineMap: { documentVersion: 0, endings: [] } },
        } };
        if (command === 'save_document') {
          saves.push(args);
          return new Promise(resolve => Reflect.set(window, 'completeFixtureSave', () => resolve({ ok: true, value: {
            documentVersion: args.documentVersion, diskRevision: `rev-${saves.length}`, savedAt: '2026-11-01T00:00:00Z', sizeBytes: args.text.length,
          } })));
        }
        throw new Error('Unexpected Web mock command');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 第一段');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('正在保存');
  await page.keyboard.insertText(' 保存中新输入');
  await page.evaluate(() => { const complete = Reflect.get(window, 'completeFixtureSave') as () => void; complete(); });
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await expect(page.locator('.cm-content')).toHaveText('baseline 第一段 保存中新输入');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('正在保存');
  await page.evaluate(() => { const complete = Reflect.get(window, 'completeFixtureSave') as () => void; complete(); });
  await expect(page.getByRole('status')).toContainText('未修改');
  await expect(page.getByRole('tab')).not.toContainText('●');
  const requests = await page.evaluate(() => Reflect.get(window, 'fixtureSaves') as { text: string; expectedDiskRevision: string }[]);
  expect(requests.map(request => request.text)).toEqual(['baseline 第一段', 'baseline 第一段 保存中新输入']);
  expect(requests[1]?.expectedDiskRevision).toBe('rev-1');
  await page.screenshot({ path: '.artifacts/T102/save-web.png' });
});

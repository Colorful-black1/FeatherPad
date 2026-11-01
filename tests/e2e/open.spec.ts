import { expect, test } from '@playwright/test';

test('Web mock verifies native bridge requests and read-only CodeMirror rendering', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: async (command: string) => {
        if (command === 'choose_files') return { ok: true, value: { grants: [{ grantId: 'fixture-grant', relativePath: '' }], failures: [] } };
        if (command === 'open_document') return { ok: true, value: {
          documentId: 'fixture-document', ref: { grantId: 'fixture-grant', relativePath: '' },
          metadata: { displayPath: '中文 fixture.txt', sizeBytes: 12, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: true, diskRevision: 'fixture-revision' },
          format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
          content: { kind: 'text', text: '受控文件\nFeatherPad', newlineMap: { documentVersion: 0, endings: ['lf'] } },
        } };
        throw new Error('Unexpected command in Web mock');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('受控文件');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('.document-heading')).toContainText('中文 fixture.txt');
  await expect(page.getByRole('status')).toContainText('只读');
});

test('plain Web mode shows a visible transport failure without faking an open', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法连接本地文件服务');
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

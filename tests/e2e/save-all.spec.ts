import { expect, test, type Page } from '@playwright/test';

async function installBatchMock(page: Page, mode: 'third-failure' | 'cancel' | 'held') {
  await page.addInitScript(({ mode }) => {
    interface Request { documentId: string; documentVersion: number; requestId: string; text: string }
    const requests: Request[] = [];
    Reflect.set(window, 'batchRequests', requests);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Request) => {
      if (command !== 'save_document_as') throw new Error('Unexpected Web mock command');
      requests.push(args);
      const number = requests.length;
      if (mode === 'third-failure' && number === 3) return { ok: false, error: { code: 'DISK_FULL', message: `受控磁盘空间不足：${'请保留当前内容并稍后重试。'.repeat(5)}`, retryable: false } };
      if (mode === 'cancel' && number === 2) return { ok: false, error: { code: 'CANCELLED', message: 'controlled cancel', retryable: false } };
      if (mode === 'held' && number === 1) await new Promise<void>(resolve => Reflect.set(window, 'releaseBatchAck', resolve));
      const sizeBytes = new TextEncoder().encode(args.text).length;
      const diskRevision = `saved-${number}`;
      return { ok: true, value: { documentId: args.documentId, ref: { grantId: `grant-${number}`, relativePath: '' },
        metadata: { displayPath: `保存 ${number}.txt`, sizeBytes, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision },
        ack: { documentVersion: args.documentVersion, diskRevision, savedAt: '2026-11-01T00:00:00Z', sizeBytes } } };
    } });
  }, { mode });
}

async function createDrafts(page: Page, count: number) {
  for (let index = 1; index <= count; index++) {
    await page.getByRole('button', { name: '新建文本', exact: true }).click();
    await page.keyboard.insertText(`第${index}份中文😀草稿`);
  }
}

test('Web mock: save-all lists a third-item failure and keeps that buffer dirty at 200% zoom', async ({ page }) => {
  await installBatchMock(page, 'third-failure');
  await page.goto('/');
  await createDrafts(page, 4);
  await page.getByRole('button', { name: '全部保存', exact: true }).click();
  const results = page.getByRole('region', { name: '全部保存', exact: true });
  await expect(results).toContainText('本次处理结束：已处理 4 / 4 份');
  const rows = results.getByRole('listitem');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('已保存');
  await expect(rows.nth(1)).toContainText('已保存');
  await expect(rows.nth(2)).toContainText('保存失败：受控磁盘空间不足');
  await expect(rows.nth(3)).toContainText('已保存');
  await expect(results.getByRole('progressbar')).toHaveAttribute('value', '4');
  await expect(page.getByRole('tab', { name: /无标题 3/ })).toContainText('●');
  await results.getByRole('button', { name: '无标题 3', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('第3份中文😀草稿');
  await expect(page.getByRole('status')).toContainText('未保存修改');
  await page.setViewportSize({ width: 1600, height: 1120 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await rows.nth(2).getByText(/^保存失败/).scrollIntoViewIfNeeded();
  await expect(results.getByRole('button', { name: '关闭保存结果' })).toBeInViewport();
  await expect(page.locator('.cm-editor')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.artifacts/T102/save-all-failure-web.png' });
  await results.getByRole('button', { name: '关闭保存结果' }).click();
  await expect(page.getByRole('button', { name: '全部保存', exact: true })).toBeFocused();
});

test('Web mock: cancelled chooser stops subsequent items and a new run only retries remaining dirty drafts', async ({ page }) => {
  await installBatchMock(page, 'cancel');
  await page.goto('/');
  await createDrafts(page, 3);
  await page.getByRole('button', { name: '全部保存', exact: true }).click();
  const results = page.getByRole('region', { name: '全部保存', exact: true });
  await expect(results).toContainText('本次处理结束：已处理 2 / 3 份');
  const rows = results.getByRole('listitem');
  await expect(rows.nth(1)).toContainText('已取消保存');
  await expect(rows.nth(2)).toContainText('未处理');
  await expect(page.getByRole('tab', { name: /无标题 2/ })).toContainText('●');
  await expect(page.getByRole('tab', { name: /无标题 3/ })).toContainText('●');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (Reflect.get(window, 'batchRequests') as unknown[]).length)).toBe(2);
  await page.getByRole('button', { name: '全部保存', exact: true }).click();
  await expect(results).toContainText('本次处理结束：已处理 2 / 2 份');
  await expect(results).toContainText('当前仍有 0 份未保存修改');
  await expect(page.getByRole('tab', { name: '保存 1.txt', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => (Reflect.get(window, 'batchRequests') as unknown[]).length)).toBe(4);
});

test('Web mock: stopping waits for the current Ack and reports input added during that save', async ({ page }) => {
  await installBatchMock(page, 'held');
  await page.goto('/');
  await createDrafts(page, 2);
  await page.getByRole('button', { name: '全部保存', exact: true }).click();
  const results = page.getByRole('region', { name: '全部保存', exact: true });
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseBatchAck'))).toBe('function');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: /无标题 1/ }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 保存期间的新输入');
  await results.getByRole('button', { name: '停止后续保存' }).click();
  await expect(results).toContainText('正在停止，等待当前保存结果');
  await expect(results.getByRole('button', { name: '等待当前保存结束…' })).toBeDisabled();
  await page.evaluate(() => { (Reflect.get(window, 'releaseBatchAck') as () => void)(); });
  await expect(results).toContainText('本次处理结束：已处理 1 / 2 份');
  await expect(results.getByRole('listitem').nth(0)).toContainText('已保存当时内容；仍有未保存修改');
  await expect(results.getByRole('listitem').nth(1)).toContainText('未处理');
  await expect(page.getByRole('tab', { name: /保存 1.txt/ })).toContainText('●');
  await expect(page.locator('.cm-content')).toContainText('保存期间的新输入');
  expect(await page.evaluate(() => (Reflect.get(window, 'batchRequests') as unknown[]).length)).toBe(1);
});

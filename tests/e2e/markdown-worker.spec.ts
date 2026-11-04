import { documentOptions, resumeEditing } from '../ui-actions';
import { expect, test } from './test-fixture';

test('completed previews reuse a bounded worker while each new version renders current content', async ({ page }) => {
  await page.addInitScript(() => {
    let created = 0;
    const NativeWorker = Worker;
    Reflect.set(window, 'Worker', new Proxy(NativeWorker, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        if (String(args[0]).includes('markdown.worker')) {
          Reflect.set(window, '__markdownWorkersCreated', ++created);
        }
        return Reflect.construct(target, args);
      },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown'); await resumeEditing(page);
  const editor = page.locator('.cm-content'); await editor.focus();
  await page.keyboard.insertText('# First version');
  await page.getByRole('button', { name: '分屏', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('heading', { name: 'First version', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__markdownWorkersCreated'))).toBe(1);
  const channelBefore = await frame.locator('body').getAttribute('data-channel');
  await page.evaluate(() => Reflect.set(window, '__markdownPreviewFrame', document.querySelector('iframe[title*="Markdown阅读"]')));
  await editor.focus(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\n# Second version');
  await expect(frame.getByRole('heading', { name: 'Second version', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__markdownWorkersCreated'))).toBe(1);
  const channelAfter = await frame.locator('body').getAttribute('data-channel');
  const frameIdentity = await page.evaluate(() => {
    const current = document.querySelector('iframe[title*="Markdown阅读"]');
    return { same: Reflect.get(window, '__markdownPreviewFrame') === current,
      count: document.querySelectorAll('iframe[title*="Markdown阅读"]').length, title: current?.getAttribute('title') };
  });
  expect(channelAfter).toBe(channelBefore);
  expect(frameIdentity).toMatchObject({ same: true, count: 1 });
  await editor.focus(); await page.keyboard.press('Control+z');
  await expect(frame.getByRole('heading', { name: 'Second version', exact: true })).toHaveCount(0);
  await expect(frame.getByRole('heading', { name: 'First version', exact: true })).toBeVisible();
});

test('a nonresponsive preview worker is terminated at budget and retry retains the source', async ({ page }) => {
  await page.addInitScript(() => {
    let first = true;
    const NativeWorker = Worker;
    Reflect.set(window, 'Worker', new Proxy(NativeWorker, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        const worker: Worker = Reflect.construct(target, args);
        if (first && String(args[0]).includes('markdown.worker')) {
          first = false;
          worker.postMessage = () => {}; // Controlled stalled job, never document code.
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => { Reflect.set(window, '__stalledWorkerTerminated', true); terminate(); };
        }
        return worker;
      },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('markdown'); await resumeEditing(page);
  const editor = page.locator('.cm-content'); await editor.focus();
  await page.keyboard.insertText('# Kept after timeout');
  await page.getByRole('button', { name: '分屏', exact: true }).click();
  await expect(page.getByText('阅读渲染超过2秒预算，已取消；源码仍保留。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__stalledWorkerTerminated'))).toBe(true);
  await expect(editor).toHaveText('# Kept after timeout');
  await page.getByRole('button', { name: '生成一次预览', exact: true }).click();
  await expect(page.frameLocator('iframe[title*="Markdown阅读"]').getByRole('heading', { name: 'Kept after timeout' })).toBeVisible();
});

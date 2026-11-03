import { expect, test } from './test-fixture';

test('Markdown three modes share the CodeMirror buffer and undo, render GFM, and resize with the keyboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  const source = '# 中文阅读\n\n| 一 | 二 |\n| --- | --- |\n| 值 | ~~删除~~ |\n\n- [x] 已完成\n\n> 引用\n';
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText(source);
  const lines = await page.locator('.cm-line').allTextContents();
  const modes = page.getByRole('group', { name: '主编辑组 Markdown视图' });
  await expect(modes.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await modes.getByRole('button', { name: '分屏', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('heading', { name: '中文阅读' })).toBeVisible();
  await expect(frame.locator('table')).toBeVisible();
  await expect(frame.locator('del')).toHaveText('删除');
  await expect(frame.getByRole('checkbox')).toBeChecked();
  const divider = page.getByRole('separator', { name: '源码与阅读分隔' });
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '51');
  await modes.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(editor).toBeHidden();
  await modes.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(lines);
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await page.keyboard.press('Control+y');
  await expect(page.locator('.cm-line')).toHaveText(lines);
  expect(errors).toEqual([]);
});

test('Markdown preview isolates scripts and IPC, blocks remote images, and replaces old versions', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) externalRequests.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText('# 原版本\n\n<script>parent.pwned=1</script>\n\n![远程](https://example.com/leak.png)\n\n[危险](javascript:alert%281%29)');
  const modes = page.getByRole('group', { name: '主编辑组 Markdown视图' });
  await modes.getByRole('button', { name: '分屏', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('heading', { name: '原版本' })).toBeVisible();
  await expect(frame.locator('script:not([data-featherpad-runtime]), img, [onclick], [onerror], a[href]')).toHaveCount(0);
  await expect(frame.locator('script[data-featherpad-runtime][nonce]')).toHaveCount(1);
  await expect(frame.getByText('[图片未加载：远程]', { exact: true })).toBeVisible();
  expect(await frame.locator('body').evaluate(() => {
    let isolated = false;
    try { void window.parent.document; } catch { isolated = true; }
    return { isolated, ipc: '__TAURI_INTERNALS__' in window };
  })).toEqual({ isolated: true, ipc: false });
  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('# 新版本');
  await expect(frame.getByRole('heading', { name: '新版本' })).toBeVisible();
  await expect(frame.getByRole('heading', { name: '原版本' })).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
});

test('Markdown mode belongs to each editor group and narrow layouts retain access to source', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  await page.locator('.cm-content').focus();
  await page.keyboard.insertText('# 双组正文');
  await page.getByRole('button', { name: '向右拆分', exact: true }).click();
  const primary = page.getByRole('group', { name: '主编辑组 Markdown视图' });
  const secondary = page.getByRole('group', { name: '第二编辑组 Markdown视图' });
  await secondary.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(primary.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.frameLocator('iframe[title*="Markdown阅读"]').getByRole('heading', { name: '双组正文' })).toBeVisible();
  await secondary.getByRole('button', { name: '分屏', exact: true }).click();
  await expect(page.getByText('空间不足，分屏暂以阅读显示；可切换源码或扩大编辑区域。')).toBeVisible();
  await secondary.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveCount(2);
});

test('Markdown tasks edit exact duplicate positions in one undo and code copy stays literal', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText('- [ ] 重复\n- [ ] 重复\n  - [x] 嵌套\n\n```json\n{"中文": true}\n```');
  const modes = page.getByRole('group', { name: '主编辑组 Markdown视图' });
  await modes.getByRole('button', { name: '分屏', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('checkbox')).toHaveCount(3);
  await expect(frame.locator('code .tok-propertyName')).toBeVisible();
  await frame.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.getByText('代码已复制。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{"中文": true}');
  await frame.getByRole('checkbox').nth(1).check();
  await expect(page.locator('.cm-line').nth(0)).toHaveText('- [ ] 重复');
  await expect(page.locator('.cm-line').nth(1)).toHaveText('- [x] 重复');
  await expect(frame.getByRole('checkbox').nth(1)).toBeChecked();
  await modes.getByRole('button', { name: '阅读', exact: true }).click();
  await frame.getByRole('checkbox').nth(1).focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line').nth(1)).toHaveText('- [ ] 重复');
  await expect(page.locator('.cm-line').nth(2)).toHaveText('  - [x] 嵌套');
  await expect(frame.getByRole('checkbox').nth(1)).not.toBeChecked();
  const channel = await frame.locator('body').getAttribute('data-channel');
  const before = await page.locator('.cm-line').allTextContents();
  await page.evaluate(value => window.postMessage({ channel: value, kind: 'task', index: 0 }, '*'), channel);
  await expect(page.locator('.cm-line')).toHaveText(before);
});

test('Web mock: Markdown local resources require a base, sanitize SVG, retain failures and never fetch remote images', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) externalRequests.push(request.url()); });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let version = 0;
    const revision = () => version ? version.toString(16).padStart(64, '0') : null;
    const ok = (value: unknown) => ({ ok: true, value });
    const reads: string[] = [];
    Reflect.set(window, 'previewReads', reads);
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version, revision: revision(), settings: {}, warning: null, recoveryCopies: [] });
        case 'save_settings': return ok({ version: ++version, revision: revision() });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'choose_folder': return ok({ grant: { grantId: '11111111-1111-4111-8111-111111111111', relativePath: '' }, displayName: '受控资源目录' });
        case 'read_preview_resource': {
          const url = String(args.url);
          reads.push(url);
          if (url === 'picture.svg') {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="parent.pwned=1"><script>parent.pwned=1</script><foreignObject><div>blocked</div></foreignObject><rect width="100" height="50" fill="url(https://example.com/leak)"/><image href="https://example.com/leak"/></svg>';
            return ok({ mime: 'image/svg+xml', dataBase64: btoa(svg), sizeBytes: svg.length, width: null, height: null });
          }
          if (url === '图%20100%25%23.gif') {
            const dataBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            return ok({ mime: 'image/gif', dataBase64, sizeBytes: atob(dataBase64).length, width: 1, height: 1 });
          }
          return { ok: false, error: { code: 'OUT_OF_SCOPE', message: '受控资源越界，需授权目录。', retryable: false } };
        }
        default: throw new Error(`Unexpected preview fixture command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  await page.locator('.cm-content').focus();
  await page.keyboard.insertText('![像素](图%20100%25%23.gif)\n\n![安全SVG](picture.svg)\n\n![越界](../outside/secret.gif)\n\n![远程](https://example.com/leak.png)');
  await page.getByRole('group', { name: '主编辑组 Markdown视图' }).getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('button', { name: '授权或选择资源目录…', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'previewReads'))).toEqual([]);
  await page.getByRole('button', { name: '授权或选择资源目录…', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('img', { name: '像素', exact: true })).toBeVisible();
  await expect(frame.getByRole('img', { name: '安全SVG', exact: true })).toBeVisible();
  const svg = await frame.getByRole('img', { name: '安全SVG', exact: true }).getAttribute('src');
  const cleaned = Buffer.from(svg!.split(',')[1]!, 'base64').toString('utf8');
  expect(cleaned).not.toMatch(/<script|foreignObject|onload|https:\/\/|href=/);
  await expect(frame.getByText('[图片未加载：越界]', { exact: true })).toBeVisible();
  await expect(frame.getByText('[图片未加载：远程]', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'previewReads'))).toEqual(['图%20100%25%23.gif', 'picture.svg', '../outside/secret.gif']);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
});

test('Web mock: external preview links show the exact target and require confirmation; dangerous schemes never reach native', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    let version = 0;
    const opened: unknown[] = [];
    Reflect.set(window, 'externalPreviewOpens', opened);
    const ok = (value: unknown) => ({ ok: true, value });
    Reflect.set(window, '__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
      switch (command) {
        case 'load_settings': return ok({ schemaVersion: 1, version: 0, revision: null, settings: {}, warning: null, recoveryCopies: [] });
        case 'save_settings': return ok({ version: ++version, revision: version.toString(16).padStart(64, '0') });
        case 'load_workspace_settings': return ok({ settings: {}, revision: null, warning: null });
        case 'open_external_preview': opened.push(args); return ok(true);
        default: throw new Error(`Unexpected preview link fixture command ${command}`);
      }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  await page.locator('.cm-content').focus();
  await page.keyboard.insertText('[外部](https://example.com/中文)\n\n[危险](javascript:alert%281%29)');
  await page.getByRole('group', { name: '主编辑组 Markdown视图' }).getByRole('button', { name: '阅读', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await frame.getByRole('button', { name: '外部', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '打开外部链接', exact: true });
  await expect(dialog.getByText('https://example.com/%E4%B8%AD%E6%96%87', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'externalPreviewOpens'))).toEqual([]);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'externalPreviewOpens'))).toEqual([]);
  await frame.getByRole('button', { name: '危险', exact: true }).click();
  await expect(page.getByText('已阻止不安全或不支持的协议。', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '外部', exact: true }).click();
  await dialog.getByRole('button', { name: '确认打开', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'externalPreviewOpens'))).toEqual([
    { url: 'https://example.com/%E4%B8%AD%E6%96%87', confirmed: true },
  ]);
});

test('restricted HTML requires user opt-in, strips scripts and forged controls, and never mutates Markdown', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com/')) externalRequests.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  const body = '<details open><summary>安全结构</summary><p onclick="parent.pwned=1">受限正文</p><script>parent.pwned=1</script><img src="https://example.com/leak.png" alt="HTML远程"><iframe src="https://example.com/frame"></iframe><input type="checkbox" data-task-id="0"><button data-copy-id="0">伪造复制</button></details>\n\n- [ ] 真实任务';
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText(body);
  const original = await page.locator('.cm-line').allTextContents();
  const modes = page.getByRole('group', { name: '主编辑组 Markdown视图' });
  await modes.getByRole('button', { name: '阅读', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.locator('details')).toHaveCount(0);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('checkbox', { name: '允许受限 Markdown HTML', exact: true }).check();
  await dialog.getByRole('button', { name: '仅本次应用', exact: true }).click();
  await expect(frame.locator('summary')).toHaveText('安全结构');
  await expect(frame.getByText('受限正文', { exact: true })).toBeVisible();
  await expect(frame.locator('script:not([data-featherpad-runtime]), iframe, [onclick], [onerror], img[src^="http"]')).toHaveCount(0);
  await expect(frame.getByRole('checkbox')).toHaveCount(1);
  await expect(frame.getByRole('button', { name: '伪造复制', exact: true })).toHaveCount(0);
  await expect(frame.getByText('[图片未加载：HTML远程]', { exact: true })).toBeVisible();
  await page.locator('.markdown-resource-details summary').click();
  await expect(page.getByText('远程图片默认阻止，可显式在浏览器中查看原链接。', { exact: false })).toBeVisible();
  await modes.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.cm-line')).toHaveText(original);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
});

test('Markdown outline navigates source and preview; block sync follows both sides without moving the cursor and can be disabled', async ({ page }) => {
  const source = '# 起点\n\n' + Array.from({ length: 30 }, (_, index) =>
    `## 章节 ${index + 1}\n\n段落 ${index + 1}：${'正文内容用于验证源区间同步。'.repeat(10)}\n\n`).join('');
  await page.goto('/');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语言模式' }).selectOption('markdown');
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.insertText(source);
  await page.getByRole('group', { name: '主编辑组 Markdown视图' }).getByRole('button', { name: '分屏', exact: true }).click();
  const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
  await expect(frame.getByRole('heading', { name: '起点', exact: true })).toBeVisible();
  await page.locator('.markdown-outline > summary').click();
  await page.getByRole('button', { name: '折叠或展开 起点', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Markdown目录', exact: true }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('textbox', { name: '筛选 Markdown 标题', exact: true }).fill('章节 18');
  await page.getByRole('list', { name: 'Markdown目录', exact: true }).getByRole('button', { name: '章节 18', exact: true }).click();
  const line18 = source.slice(0, source.indexOf('## 章节 18\n')).split('\n').length;
  await expect(page.getByRole('status', { name: '应用状态', exact: true })).toContainText(`行 ${line18}，列 1`);
  await expect.poll(() => frame.getByRole('heading', { name: '章节 18', exact: true }).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);
  await page.locator('.markdown-outline > summary').click();
  await editor.focus();
  await page.keyboard.press('Control+g');
  const line20 = source.slice(0, source.indexOf('## 章节 20\n')).split('\n').length;
  const goto = page.getByRole('dialog', { name: '跳转到行列', exact: true });
  await goto.getByRole('textbox', { name: '目标行', exact: true }).fill(String(line20));
  await goto.getByRole('textbox', { name: '目标列', exact: true }).fill('1');
  await goto.getByRole('button', { name: '跳转', exact: true }).click();
  const scroller = page.locator('.cm-scroller');
  await expect(page.getByRole('status', { name: '应用状态', exact: true })).toContainText(`行 ${line20}，列 1`);
  const previewBefore = await frame.locator('body').evaluate(() => document.scrollingElement!.scrollTop);
  const sourceBefore = await scroller.evaluate(element => element.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(sourceBefore + 100);
  await expect.poll(() => frame.locator('body').evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(previewBefore + 100);
  const before = await scroller.evaluate(element => element.scrollTop);
  await page.locator('iframe[title*="Markdown阅读"]').hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThan(before - 100);
  await expect(page.getByRole('status', { name: '应用状态', exact: true })).toContainText(`行 ${line20}，列 1`);
  await page.getByRole('checkbox', { name: 'Markdown同步滚动', exact: true }).uncheck();
  const disabledTop = await scroller.evaluate(element => element.scrollTop);
  const frameTop = await frame.locator('body').evaluate(() => document.scrollingElement!.scrollTop);
  await page.locator('iframe[title*="Markdown阅读"]').hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => frame.locator('body').evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(frameTop + 100);
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(disabledTop);
});

import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release reads a shared Markdown buffer offline in an isolated preview without changing source bytes', async () => {
  test.setTimeout(90_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'markdown');
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-markdown-'));
  const resourceRoot = path.join(dataDir, '受控资源根');
  const documentRoot = path.join(resourceRoot, '文档');
  await mkdir(documentRoot, { recursive: true });
  await mkdir(path.join(resourceRoot, 'assets'));
  const source = path.join(documentRoot, '中文 Markdown😀.md');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  await writeFile(path.join(documentRoot, '图 100%#.gif'), gif);
  await writeFile(path.join(resourceRoot, 'assets/授权.gif'), gif);
  await writeFile(path.join(documentRoot, '受控.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="parent.pwned=1"><script>parent.pwned=1</script><rect width="100" height="50" fill="green"/><image href="https://example.com/leak"/></svg>');
  await writeFile(path.join(documentRoot, 'linked.md'), '# 链接文档\r\n');
  const body = '# 原生阅读\r\n\r\n| 一 | 二 |\r\n| --- | --- |\r\n| 中文 | ~~删除~~ |\r\n\r\n- [x] 完成\r\n\r\n<script>parent.pwned=1</script>\r\n\r\n![远程](https://example.com/leak.png)\r\n\r\n![像素](图%20100%25%23.gif)\r\n\r\n![安全SVG](受控.svg)\r\n\r\n![待授权](../assets/授权.gif)\r\n\r\n<details open><summary>原生受限HTML</summary><p onclick="parent.pwned=1">清洗正文</p><input type="checkbox" data-task-id="0"><script>parent.pwned=1</script></details>\r\n\r\n[同目录文件](linked.md)\r\n';
  await writeFile(source, body, 'utf8');
  const originalHash = sha(await readFile(source));
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Missing CDP port')); return; }
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(executable, [], { cwd: project, windowsHide: false, stdio: 'ignore', env: {
    ...process.env, FEATHERPAD_USER_DATA_DIR: path.join(dataDir, 'featherpad-state'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(dataDir, 'profile'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  } });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const diagnostics: string[] = [];
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Native child exited ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    page.on('console', entry => { if (entry.type() === 'error' || entry.type() === 'warning') diagnostics.push(entry.text()); });
    page.on('pageerror', error => diagnostics.push(error.message));
    const requests: string[] = [];
    page.on('request', request => { if (request.url().startsWith('https://example.com/')) requests.push(request.url()); });
    await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    const chooser = new NativeChooser({ page, child, dataDir, executable, executableSha256, evidence, cleanupTasks: [] });
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    await chooser.select('open', source);
    const modes = page.getByRole('group', { name: '主编辑组 Markdown视图' });
    await expect(modes.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const lines = await page.locator('.cm-line').allTextContents();
    await modes.getByRole('button', { name: '分屏', exact: true }).click();
    const frame = page.frameLocator('iframe[title*="Markdown阅读"]');
    await expect(frame.getByRole('heading', { name: '原生阅读' })).toBeVisible();
    await expect(frame.locator('table')).toBeVisible();
    await expect(frame.locator('script:not([data-featherpad-runtime]),img[src^="http"],[onerror],[onclick]')).toHaveCount(0);
    await expect(frame.locator('script[data-featherpad-runtime][nonce]')).toHaveCount(1);
    await expect(frame.getByRole('img', { name: '像素', exact: true })).toBeVisible();
    await expect(frame.getByRole('img', { name: '安全SVG', exact: true })).toBeVisible();
    const svgSource = await frame.getByRole('img', { name: '安全SVG', exact: true }).getAttribute('src');
    expect(Buffer.from(svgSource!.split(',')[1]!, 'base64').toString('utf8')).not.toMatch(/<script|onload|https:\/\/|href=/);
    await expect(frame.getByRole('img', { name: '待授权', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '授权或选择资源目录…', exact: true }).click();
    await chooser.select('open-folder', resourceRoot);
    await expect(frame.getByRole('img', { name: '待授权', exact: true })).toBeVisible();
    const isolation = await frame.locator('body').evaluate(() => {
      let isolated = false;
      try { void window.parent.document; } catch { isolated = true; }
      return { isolated, ipc: '__TAURI_INTERNALS__' in window };
    });
    expect(isolation).toEqual({ isolated: true, ipc: false });
    await frame.getByRole('checkbox').uncheck({ timeout: 5000 });
    await expect(page.locator('.cm-line').nth(6)).toHaveText('- [ ] 完成');
    await expect(frame.getByRole('checkbox')).not.toBeChecked();
    await frame.getByRole('checkbox').focus();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-line')).toHaveText(lines);
    await expect(frame.getByRole('checkbox')).toBeChecked();
    await modes.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(page.locator('.cm-content')).toBeHidden();
    await modes.getByRole('button', { name: '源码', exact: true }).click();
    await expect(page.locator('.cm-line')).toHaveText(lines);
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n\n## 追加内容\n');
    await modes.getByRole('button', { name: '分屏', exact: true }).click();
    await expect(frame.getByRole('heading', { name: '追加内容', exact: true })).toBeVisible();
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-line')).toHaveText(lines);
    await expect(frame.getByRole('heading', { name: '原生阅读', exact: true })).toBeVisible();
    await expect(frame.getByRole('heading', { name: '追加内容', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('checkbox', { name: '允许受限 Markdown HTML', exact: true }).check();
    await settings.getByRole('button', { name: '仅本次应用', exact: true }).click();
    await expect(frame.locator('summary')).toHaveText('原生受限HTML');
    await expect(frame.getByRole('checkbox')).toHaveCount(1);
    await expect(frame.locator('script:not([data-featherpad-runtime]),[onclick],[onload],iframe')).toHaveCount(0);
    expect(sha(await readFile(source))).toBe(originalHash);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
    await page.screenshot({ path: path.join(evidence, 'markdown-split.png') });
    await modes.getByRole('button', { name: '源码', exact: true }).click();
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n\n## 只在缓冲的导出内容\n');
    await page.getByRole('button', { name: '导出…', exact: true }).click();
    const exporter = page.getByRole('dialog', { name: '导出 Markdown', exact: true });
    await expect(exporter.getByText(/当前未保存内容/)).toBeVisible();
    await expect(exporter.getByRole('region', { name: '导出缺失资源', exact: true })).toContainText('远程');
    const htmlTarget = path.join(dataDir, '离线导出.html');
    await exporter.getByRole('button', { name: '带占位继续导出…', exact: true }).click();
    await chooser.select('save', htmlTarget);
    await expect(exporter).toBeHidden();
    const html = await readFile(htmlTarget, 'utf8');
    expect(html).toContain('只在缓冲的导出内容');
    expect(html).toContain('data:image/gif;base64,');
    expect(html).not.toMatch(/<script|__TAURI|data-(?:task|copy|link|source)-|https:\/\/example.com\/leak|file:\/\//i);
    expect(html).not.toContain(dataDir);
    expect(sha(await readFile(source))).toBe(originalHash);
    const portableContext = await chromium.launchPersistentContext(path.join(dataDir, 'portable-profile'), { channel: 'msedge', headless: true, offline: true });
    try {
      const portable = portableContext.pages()[0]!;
      await portable.goto(`file:///${htmlTarget.replaceAll('\\', '/')}`);
      await expect(portable.getByRole('heading', { name: '只在缓冲的导出内容', exact: true })).toBeVisible();
      await expect.poll(() => portable.getByRole('img', { name: '像素', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
      expect(await portable.locator('script').count()).toBe(0);
    } finally { await portableContext.close(); }
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-line')).toHaveText(lines);
    await modes.getByRole('button', { name: '分屏', exact: true }).click();
    await expect(frame.getByRole('heading', { name: '原生阅读', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: '同目录文件', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'linked.md', exact: true })).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveText('# 链接文档');
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      executableSha256, dataDir, webview2: await page.evaluate(() => navigator.userAgent),
      originalHash, afterHash: sha(await readFile(source)), isolation, remoteRequests: requests.length,
      realChooser: true, sharedBufferAndUndo: true, browserOffline: true, sourceBytesUnchanged: true,
      localImages: true, svgSanitized: true, directoryAuthorization: true, restrictedHtml: true, localLinkOpened: true,
      htmlTarget, htmlSha256: sha(await readFile(htmlTarget)), htmlOfflineReopened: true, dirtySnapshotExported: true }, null, 2));
  } finally {
    await writeFile(path.join(evidence, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    if (child.exitCode === null) child.kill();
    await browser?.close();
  }
});

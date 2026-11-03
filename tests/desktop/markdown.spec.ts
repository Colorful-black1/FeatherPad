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
  const source = path.join(dataDir, '中文 Markdown😀.md');
  const body = '# 原生阅读\r\n\r\n| 一 | 二 |\r\n| --- | --- |\r\n| 中文 | ~~删除~~ |\r\n\r\n- [x] 完成\r\n\r\n<script>parent.pwned=1</script>\r\n\r\n![远程](https://example.com/leak.png)\r\n';
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
    await expect(frame.locator('script,img,[onerror],[onclick]')).toHaveCount(0);
    const isolation = await frame.locator('body').evaluate(() => {
      let isolated = false;
      try { void window.parent.document; } catch { isolated = true; }
      return { isolated, ipc: '__TAURI_INTERNALS__' in window };
    });
    expect(isolation).toEqual({ isolated: true, ipc: false });
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
    expect(sha(await readFile(source))).toBe(originalHash);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
    await page.screenshot({ path: path.join(evidence, 'markdown-split.png') });
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      executableSha256, dataDir, webview2: await page.evaluate(() => navigator.userAgent),
      originalHash, afterHash: sha(await readFile(source)), isolation, remoteRequests: requests.length,
      realChooser: true, sharedBufferAndUndo: true, browserOffline: true, sourceBytesUnchanged: true }, null, 2));
  } finally {
    if (child.exitCode === null) child.kill();
    await browser?.close();
  }
});

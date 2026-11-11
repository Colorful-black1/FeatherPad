import { menuItem } from '../ui-actions';
import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release isolates image and HTML views and compares independent disk snapshots without writing sources', async () => {
  test.setTimeout(150_000);
  const project = process.cwd(), executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'content');
  await mkdir(evidence, { recursive: true }); await mkdir(path.join(project, '.artifacts/T002'), { recursive: true });
  const dataDir = await mkdtemp(path.join(project, '.artifacts/T002/webview2-content-'));
  const gif = path.join(dataDir, '动画.gif'), svg = path.join(dataDir, '安全.svg'), html = path.join(dataDir, '静态.html');
  const left = path.join(dataDir, '左.txt'), right = path.join(dataDir, '右.txt');
  const rasterFixtures = [
    ['PNG.png', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGMUDzFhYGBgYgADKAUADAQApXHePu4AAAAASUVORK5CYII='],
    ['WebP.webp', 'UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoCAAMAAUAmJZgCdAF1AAD+9w1gyMi/8B/Ev7AsQAA='],
    ['JPEG.jpg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDz2iiisjxj/9k='],
  ] as const;
  for (const [name, bytes] of rasterFixtures) await writeFile(path.join(dataDir, name), Buffer.from(bytes, 'base64'));
  // Controlled 8x8 red/green frames, 200ms delay and infinite looping.
  const gifBytes = Buffer.from('47494638396108000800810000ff000000000000000000000021ff0b4e45545343415045322e30030100000021f90400140000002c000000000800080000080f0001081c48b0a0c18308132a4c18100021f90401140001002c00000000080008008100ff00000000000000000000080f0001081c48b0a0c18308132a4c1810003b', 'hex');
  await writeFile(gif, gifBytes);
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" onload="parent.contentPwned=1"><script>parent.contentPwned=1</script><rect width="80" height="40" fill="green"/><image href="https://example.com/leak"/></svg>');
  await writeFile(html, '<h1 onclick="parent.contentPwned=1">原生静态HTML</h1><script>parent.contentPwned=1</script><img src="动画.gif" alt="本地动画"><img src="https://example.com/leak" alt="远程"><form action="https://example.com/post"><input></form><a href="https://example.com/go">不可导航</a>');
  await writeFile(left, '共同\r\n左侧内容\r\n结尾\r\n'); await writeFile(right, '共同\r\n右侧内容\r\n结尾\r\n');
  let externalHits = 0;
  const endpoint = `/featherpad-controlled-${crypto.randomUUID()}`;
  const linkServer = createHttpServer((request, response) => {
    if (request.url === endpoint) externalHits++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" });
    response.end('<!doctype html><title>FeatherPad 本机链接验收</title><h1>本机受控链接已打开</h1><p>这是本地测试页面，可以关闭此标签。</p>');
  });
  const linkPort = await new Promise<number>((resolve, reject) => {
    linkServer.once('error', reject); linkServer.listen(0, '127.0.0.1', () => {
      const address = linkServer.address(); if (!address || typeof address === 'string') { reject(new Error('Missing local link port')); return; }
      resolve(address.port);
    });
  });
  const linkUrl = `http://127.0.0.1:${linkPort}${endpoint}`, markdown = path.join(dataDir, '本机外链.md');
  await writeFile(markdown, `[本机外链](${linkUrl})`);
  const originals = new Map(await Promise.all([gif, svg, html, left, right].map(async file => [file, sha(await readFile(file))] as const)));
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('Missing CDP port')); return; }
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(executable, [], { cwd: project, windowsHide: false, stdio: 'ignore', env: { ...process.env,
    FEATHERPAD_USER_DATA_DIR: path.join(dataDir, 'state'), WEBVIEW2_USER_DATA_FOLDER: path.join(dataDir, 'profile'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  } });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const diagnostics: string[] = [], requests: string[] = [];
  try {
    await expect.poll(async () => { if (child.exitCode !== null) throw new Error(`Native child exited ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); const context = browser.contexts()[0]!;
    await context.setOffline(true); await expect.poll(() => context.pages().length).toBeGreaterThan(0); const page = context.pages()[0]!;
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('request', request => { if (request.url().startsWith('https://example.com/')) requests.push(request.url()); });
    const chooser = new NativeChooser({ page, child, dataDir, executable, executableSha256, evidence, cleanupTasks: [] });
    async function open(file: string) { await page.getByRole('button', { name: '打开文件', exact: true }).click(); await chooser.select('open', file); }
    await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
    await open(gif); const image = page.getByRole('img', { name: '动画.gif', exact: true });
    await expect(image).toBeVisible(); await expect(page.getByLabel('图片尺寸与大小', { exact: true })).toContainText('8 × 8');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect((await menuItem(page, '另存为'))).toBeDisabled();
    await page.getByRole('spinbutton', { name: '图片缩放百分比', exact: true }).fill('800');
    const frames = new Set<string>(), capture = await context.newCDPSession(page);
    const box = await image.boundingBox(); if (!box) throw new Error('GIF viewport missing');
    for (let i = 0; i < 8; i++) {
      const shot = await capture.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } });
      const bytes = Buffer.from(shot.data, 'base64'); frames.add(sha(bytes)); await writeFile(path.join(evidence, `gif-frame-${i}.png`), bytes);
      await page.waitForTimeout(130);
    }
    await capture.detach();
    expect(frames.size).toBeGreaterThan(1);
    await page.getByRole('button', { name: '暂停GIF动画', exact: true }).click(); const canvas = page.getByLabel('GIF暂停帧', { exact: true });
    await expect(canvas).toBeVisible(); await expect(image).toBeHidden();
    const frozen = await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL());
    await page.waitForTimeout(350); expect(await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(frozen);
    await page.getByRole('button', { name: '恢复GIF动画', exact: true }).click(); await expect(image).toBeVisible();
    for (const [name] of rasterFixtures) {
      await open(path.join(dataDir, name));
      await expect(page.getByRole('img', { name, exact: true })).toBeVisible();
      await expect(page.getByLabel('图片尺寸与大小', { exact: true })).toContainText('2 × 3');
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    }
    await open(svg); const safeSvg = await page.getByRole('img', { name: '安全.svg', exact: true }).getAttribute('src');
    expect(Buffer.from(safeSvg!.split(',')[1]!, 'base64').toString()).not.toMatch(/<script|onload|https:\/\/|href=/);
    await page.getByRole('button', { name: '作为文本打开（UTF-8）', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('<svg'); await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await open(html); await expect(page.locator('.cm-content')).toContainText('原生静态HTML');
    const lines = await page.locator('.cm-line').allTextContents();
    const modes = page.getByRole('group', { name: 'HTML视图', exact: true }); await modes.getByRole('button', { name: '静态预览', exact: true }).click();
    const frame = page.frameLocator('iframe[title*="HTML静态预览"]');
    await expect(frame.getByRole('heading', { name: '原生静态HTML', exact: true })).toBeVisible();
    await expect.poll(() => frame.getByRole('img', { name: '本地动画', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(8);
    await expect(frame.locator('script,form,input,a[href],[onclick],img[src^="http"]')).toHaveCount(0);
    const isolation = await frame.locator('body').evaluate(() => { let isolated = false; try { void parent.document; } catch { isolated = true; }
      return { isolated, ipc: '__TAURI_INTERNALS__' in window, wryIpc: 'ipc' in window }; });
    expect(isolation).toEqual({ isolated: true, ipc: false, wryIpc: false });
    expect(await page.evaluate(() => Reflect.get(window, 'contentPwned'))).toBeUndefined(); expect(requests).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'html-isolated.png') });
    await modes.getByRole('button', { name: '源码', exact: true }).click(); await expect(page.locator('.cm-line')).toHaveText(lines);
    await (await menuItem(page, '比较文件…')).click(); const diff = page.getByRole('region', { name: '双文件对比', exact: true });
    await diff.getByRole('button', { name: '选择左侧磁盘文件…', exact: true }).click(); await chooser.select('open', left);
    await diff.getByRole('button', { name: '选择右侧磁盘文件…', exact: true }).click(); await chooser.select('open', right);
    await diff.getByRole('button', { name: '生成对比', exact: true }).click();
    await expect(diff.getByRole('group', { name: '双文件差异导航', exact: true })).toContainText('差异 1 / 1');
    await expect(diff.locator('.cm-content[contenteditable="true"]')).toHaveCount(0);
    await expect(diff.locator('.cm-content').nth(0)).toContainText('左侧内容'); await expect(diff.locator('.cm-content').nth(1)).toContainText('右侧内容');
    await writeFile(right, '共同\r\n外部新内容\r\n结尾\r\n');
    await expect(diff.getByText('右侧磁盘已有变化，仍保留读取时的快照，请重新读取。', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(diff.locator('.cm-content').nth(1)).toContainText('右侧内容');
    await diff.getByRole('button', { name: '重新读取右侧', exact: true }).click(); await diff.getByRole('button', { name: '生成对比', exact: true }).click();
    await expect(diff.locator('.cm-content').nth(1)).toContainText('外部新内容');
    await page.screenshot({ path: path.join(evidence, 'readonly-diff.png') });
    await diff.getByRole('button', { name: '关闭对比', exact: true }).click(); await expect(page.locator('.cm-line')).toHaveText(lines);
    await open(markdown); await expect(page.locator('.cm-content')).toContainText('本机外链');
    await page.getByRole('group', { name: '主编辑组 Markdown视图' }).getByRole('button', { name: '阅读', exact: true }).click();
    const md = page.frameLocator('iframe[title*="Markdown阅读"]');
    await md.getByRole('button', { name: '本机外链', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '打开外部链接', exact: true });
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); expect(externalHits).toBe(0);
    await md.getByRole('button', { name: '本机外链', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认打开', exact: true }).click();
    await expect.poll(() => externalHits, { timeout: 15_000 }).toBeGreaterThan(0);
    for (const file of [gif, svg, html, left]) expect(sha(await readFile(file))).toBe(originals.get(file));
    expect((await readFile(right, 'utf8'))).toBe('共同\r\n外部新内容\r\n结尾\r\n');
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({ checkedAt: new Date().toISOString(), executableSha256,
      webview2: await page.evaluate(() => navigator.userAgent), dataDir, realChooser: true, browserOffline: true,
      animatedFrames: frames.size, pausedFrameStable: true, svgSanitizedAndExplicitSource: true, isolation, remoteRequests: requests.length,
      independentDiskSnapshots: true, diskWatchAndReread: true, sourceBytesUnchangedExceptControlledExternalEdit: true,
      nativeRasterFormats: rasterFixtures.map(([name]) => name), externalCancelZeroRequests: true,
      actualOsExternalHandler: true, controlledLoopbackRequests: externalHits }, null, 2));
  } finally {
    await writeFile(path.join(evidence, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    if (child.exitCode === null) child.kill(); await browser?.close();
    linkServer.closeAllConnections(); await new Promise<void>(resolve => linkServer.close(() => resolve()));
  }
});

import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

test('real Tauri WebView2 shell, without a mock bridge', async () => {
  const profile = process.env.FEATHERPAD_DESKTOP_PROFILE ?? 'release';
  if (profile !== 'release' && profile !== 'debug') throw new Error('Invalid desktop build profile');
  const root = process.cwd();
  const exe = path.join(root, 'src-tauri', 'target', profile, 'featherpad.exe');
  const hash = createHash('sha256').update(await readFile(exe)).digest('hex');
  const evidence = path.join(root, '.artifacts', 'T002');
  await mkdir(evidence, { recursive: true });
  const dataDir = await mkdtemp(path.join(evidence, 'webview2-'));
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No local TCP port')); return; }
      server.close(() => resolve(address.port));
    });
  });
  // Test-only flags on this child process. No product debug endpoint or test IPC.
  const child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  let launchError: Error | undefined;
  child.once('error', error => { launchError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Native app exited ${child.exitCode}`);
      try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Native WebView2 context missing');
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (!page) throw new Error('Native WebView2 page missing');
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    expect(await page.evaluate(() => Reflect.has(window, '__TAURI_INTERNALS__'))).toBe(true);
    if (profile === 'release') expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    const darkButton = page.getByRole('button', { name: '切换到深色主题' });
    if (await darkButton.count() === 0) await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await page.screenshot({ path: path.join(evidence, `native-${profile}-light.png`) });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: path.join(evidence, `native-${profile}-dark.png`) });
    await writeFile(path.join(evidence, `native-${profile}.json`), JSON.stringify({
      checkedAt: new Date().toISOString(),
      scope: 'Real Tauri WebView2, CDP test process; no OS dialog/IME/Windows scaling coverage',
      executable: path.relative(root, exe), sha256: hash, pid: child.pid,
      profile, browserVersion: browser.version(), url: page.url(),
      checks: ['native-title', 'native-brand', 'tauri-ipc-present', 'light-theme', 'dark-theme'],
    }, null, 2));
  } finally {
    await browser?.close();
    child.kill();
  }
});

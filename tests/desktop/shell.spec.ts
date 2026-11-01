import { chromium, expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

test('real Tauri WebView2 shell, without a mock bridge', async () => {
  const verifyChooser = process.env.FEATHERPAD_VERIFY_CHOOSER !== '0';
  const chooserAutomation = process.env.FEATHERPAD_CHOOSER_AUTOMATION ?? 'native-controls';
  if (chooserAutomation !== 'native-controls' && chooserAutomation !== 'manual') throw new Error('Invalid chooser automation mode');
  if (verifyChooser) test.setTimeout(120_000);
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
    windowsHide: !verifyChooser,
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
    const rejected = await page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      const forged = await native.invoke('open_document', { ref: { grantId: 'not-issued', relativePath: 'secret.txt' } });
      const malformed = await native.invoke('open_document', { ref: { grantId: null, relativePath: 7 } });
      let ungrantedPluginRejected = false;
      try { await native.invoke('plugin:fs|read_text_file', { path: 'ungranted-fixture.txt', options: {} }); }
      catch { ungrantedPluginRejected = true; }
      return { forged, malformed, ungrantedPluginRejected };
    });
    expect(rejected.forged).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    expect(rejected.malformed).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(rejected.ungrantedPluginRejected).toBe(true);
    if (profile === 'release') {
      expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    }
    const darkButton = page.getByRole('button', { name: '切换到深色主题' });
    if (await darkButton.count() === 0) await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await page.screenshot({ path: path.join(evidence, `native-${profile}-light.png`) });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: path.join(evidence, `native-${profile}-dark.png`) });
    if (verifyChooser) {
      const fixture = path.join(dataDir, '中文 fixture.txt');
      const marker = `FeatherPad ${randomUUID()}`;
      await writeFile(fixture, `原生选择器受控文件\r\n${marker}`, 'utf8');
      const manifest = path.join(evidence, 'chooser-fixture.json');
      const selectionRecord = { fixture, processId: child.pid, workerProcessId: process.pid,
        fixtureSha256: createHash('sha256').update(await readFile(fixture)).digest('hex'), executable: exe, executableSha256: hash };
      await writeFile(manifest, JSON.stringify(selectionRecord));
      const helper = path.join(root, 'scripts', 'Select-ControlledFixture.ps1');
      if (chooserAutomation === 'native-controls') {
        const invalidManifest = path.join(evidence, 'chooser-invalid-worker.json');
        await writeFile(invalidManifest, JSON.stringify({ ...selectionRecord, workerProcessId: 0 }));
        await expect(runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', invalidManifest], { windowsHide: true, timeout: 10_000 }))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Test process identity mismatch') });
      }
      await page.getByRole('button', { name: '打开文件', exact: true }).click();
      if (chooserAutomation === 'native-controls') {
        const result = await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
        await writeFile(path.join(evidence, `native-${profile}-chooser-controls.json`), result.stdout.trim());
      }
      await expect(page.locator('.cm-content')).toContainText('原生选择器受控文件', { timeout: 90_000 });
      await expect(page.locator('.cm-line')).toHaveText(['原生选择器受控文件', marker]);
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
      expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).toBe(selectionRecord.fixtureSha256);
      await page.screenshot({ path: path.join(evidence, `native-${profile}-file.png`) });
    }
    await writeFile(path.join(evidence, `native-${profile}.json`), JSON.stringify({
      checkedAt: new Date().toISOString(),
      scope: 'Real Tauri WebView2 and real OS chooser; no mock bridge; no IME/Windows scaling coverage',
      executable: path.relative(root, exe), sha256: hash, pid: child.pid,
      profile, browserVersion: browser.version(), url: page.url(),
      nativeChooserVerified: verifyChooser,
      chooserAutomation: verifyChooser ? chooserAutomation : 'disabled-explicitly',
      browserOffline: profile === 'release',
      checks: ['native-title', 'native-brand', 'tauri-ipc-present', 'light-theme', 'dark-theme', 'forged-grant-rejected', 'malformed-ref-rejected', 'ungranted-plugin-rejected'],
    }, null, 2));
  } finally {
    try { await browser?.close(); }
    finally { child.kill(); }
  }
});

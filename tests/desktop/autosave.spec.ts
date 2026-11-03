import { chromium, expect, test } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const runFile = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release autosave stays opt-in, writes exact bytes after idle and pauses on conflicts without a dialog', async () => {
  test.setTimeout(120_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'autosave');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002'); await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-autosave-'));
  const state = path.join(dataDir, 'featherpad-state');
  const source = path.join(dataDir, '自动保存.txt');
  const original = Buffer.from('original\r\n中文😀');
  await writeFile(source, original);
  const instances: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>; diagnostics: unknown[] }[] = [];

  async function launch() {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No owned CDP port')); return; }
        server.close(() => resolve(address.port));
      });
    });
    const profile = await mkdtemp(path.join(dataDir, 'profile-'));
    const child = spawn(executable, [], { cwd: project, windowsHide: true, stdio: 'ignore', env: {
      ...process.env, FEATHERPAD_USER_DATA_DIR: state, WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    } });
    let launchError: Error | undefined; child.once('error', error => { launchError = error; });
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Owned child exited ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const diagnostics: unknown[] = []; instances.push({ child, browser, diagnostics });
    const context = browser.contexts()[0]!; await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') diagnostics.push({ type: message.type(), message: message.text() }); });
    page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: error.message }));
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    const chooser = new NativeChooser({ page, child, dataDir, executable, executableSha256, evidence, cleanupTasks: [] });
    return { page, child, browser, chooser };
  }
  async function close(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) throw new Error('Owned child is missing');
    const literal = `'${executable.replaceAll("'", "''")}'`;
    await runFile('powershell.exe', ['-NoProfile', '-Command',
      `$taskProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; if ($taskProcess.Path -ne ${literal}) { throw 'Owned executable mismatch' }; if (-not $taskProcess.CloseMainWindow()) { throw 'WM_CLOSE failed' }`],
    { windowsHide: true, timeout: 10_000 });
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
  }
  try {
    const app = await launch();
    await app.page.getByRole('button', { name: '打开文件', exact: true }).click();
    await app.chooser.select('open', source);
    await expect(app.page.locator('.cm-content')).toHaveText('original中文😀');
    await app.page.locator('.cm-content').focus(); await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText(' edited');
    await app.page.waitForTimeout(1700);
    expect((await readFile(source)).equals(original)).toBe(true);
    await app.page.getByRole('button', { name: '打开设置', exact: true }).click();
    const settings = app.page.getByRole('dialog', { name: '设置', exact: true });
    const toggle = settings.getByRole('checkbox', { name: '自动保存已命名文件', exact: true });
    await expect(toggle).not.toBeChecked(); await toggle.check();
    await app.page.waitForTimeout(1700);
    expect((await readFile(source)).equals(original)).toBe(true);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByText('设置已保存。', { exact: true })).toBeVisible();
    await app.page.waitForTimeout(1700);
    expect((await readFile(source)).equals(original)).toBe(true);
    await settings.getByRole('button', { name: '取消并还原预览', exact: true }).click();
    await expect(settings).not.toBeVisible();
    const expected = Buffer.concat([original, Buffer.from(' edited')]);
    await expect.poll(async () => (await readFile(source)).equals(expected), { timeout: 8000 }).toBe(true);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /没有未保存修改/);
    await app.page.locator('.cm-content').focus(); await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText(' local');
    const external = Buffer.from('external\r\nversion'); await writeFile(source, external);
    await expect(app.page.getByRole('status').filter({ hasText: '自动保存已暂停' })).toBeVisible();
    await app.page.waitForTimeout(1700);
    expect((await readFile(source)).equals(external)).toBe(true);
    await expect(app.page.locator('.cm-content')).toContainText('edited local');
    await expect(app.page.getByRole('dialog')).toHaveCount(0);
    await close(app.child);
    for (const instance of instances) expect(instance.diagnostics).toEqual([]);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable, executableSha256, executableBytes: (await stat(executable)).size,
      browserVersion: app.browser.version(), dataDir,
      scope: 'Real offline Release with native chooser and exact disk bytes; one controlled autosave path, no business mocks',
      defaultOff: true, settingsPreviewAndModalDoNotWrite: true, optedInIdleSavePreservesExactBytes: true,
      externalConflictPausesWithoutDialogOrOverwrite: true, localDraftRetained: true,
      originalSha256: sha(original), savedSha256: sha(expected), externalSha256: sha(external),
    }, null, 2));
  } finally {
    for (const [index, app] of instances.entries()) {
      await writeFile(path.join(evidence, `diagnostics-${index}.json`), JSON.stringify(app.diagnostics));
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

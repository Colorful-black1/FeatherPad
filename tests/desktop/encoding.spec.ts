import { documentOptions } from '../ui-actions';
import { chromium, expect, test } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const runFile = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release opens GBK, preserves mixed newlines, converts bytes, rejects loss and restores unsaved Unicode', async () => {
  test.setTimeout(120_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'encoding');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002'); await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-encoding-'));
  const state = path.join(dataDir, 'featherpad-state');
  const source = path.join(dataDir, '中文 混合换行😀.txt');
  const original = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\r\nsecond\nthird\rfourth')]);
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
    let app = await launch();
    await app.page.getByRole('button', { name: '打开文件', exact: true }).click(); await app.chooser.select('open', source);
    await app.page.getByRole('combobox', { name: '所选文件 1 的打开编码', exact: true }).selectOption('gbk');
    await app.page.getByRole('button', { name: '按编码打开所选文件 1', exact: true }).click();
    const tabId = await app.page.getByRole('tab', { selected: true }).getAttribute('id');
    expect(tabId).not.toBeNull();
    await expect(app.page.locator('.cm-content')).toHaveText('中文secondthirdfourth');
    await expect(app.page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    expect((await readFile(source)).equals(original)).toBe(true);
    await app.page.locator('.cm-content').focus(); await app.page.keyboard.press('Control+End'); await app.page.keyboard.insertText('\nadded');
    await app.page.keyboard.press('Control+s');
    const editedGbk = Buffer.concat([original, Buffer.from('\r\nadded')]);
    await expect.poll(async () => (await readFile(source)).equals(editedGbk)).toBe(true);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /没有未保存修改/);
    await (await documentOptions(app.page)).getByRole('button', { name: '编码与换行', exact: true }).click();
    const dialog = app.page.getByRole('dialog', { name: '编码与换行', exact: true });
    await dialog.getByRole('combobox', { name: '目标编码', exact: true }).selectOption('utf-16le');
    await dialog.getByRole('combobox', { name: '目标换行', exact: true }).selectOption('lf');
    await dialog.getByRole('button', { name: '应用转换', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await readFile(source)).equals(editedGbk)).toBe(true);
    await app.page.locator('.cm-content').focus(); await app.page.keyboard.press('Control+s');
    const logical = '中文\nsecond\nthird\nfourth\nadded';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(logical, 'utf16le')]);
    await expect.poll(async () => (await readFile(source)).equals(utf16)).toBe(true);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /没有未保存修改/);
    await expect(app.page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await app.page.keyboard.press('Control+z');
    await expect(app.page.locator('.status-end')).toContainText('GBK · MIXED');
    await app.page.keyboard.press('Control+s');
    await expect.poll(async () => (await readFile(source)).equals(editedGbk)).toBe(true);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /没有未保存修改/);
    await expect(app.page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await app.page.keyboard.press('Control+End'); await app.page.keyboard.insertText('😀'); await app.page.keyboard.press('Control+s');
    await expect(app.page.getByRole('alert').filter({ hasText: '无法按所选编码无损往返' })).toBeVisible();
    expect((await readFile(source)).equals(editedGbk)).toBe(true);
    const documentId = tabId!.replace(/^tab-/, '');
    await expect.poll(async () => {
      try {
        for (const receipt of await readdir(path.join(state, 'recovery'))) {
          if (!/^[0-9a-f-]{36}$/.test(receipt)) continue;
          const directory = path.join(state, 'recovery', receipt);
          const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as { documentId: string; bodySha256: string; format: { encoding: string } };
          const body = await readFile(path.join(directory, 'body.bin'));
          if (manifest.documentId === documentId && manifest.format.encoding === 'gbk' && body.toString('utf8') === `${logical}😀`) {
            expect(sha(body)).toBe(manifest.bodySha256); return true;
          }
        }
      } catch { return false; }
      return false;
    }).toBe(true);
    await close(app.child);
    app = await launch();
    await expect(app.page.locator('.cm-content')).toHaveText(`${logical.replaceAll('\n', '')}😀`);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('id', tabId!);
    await expect(app.page.locator('.status-end')).toContainText('GBK · MIXED');
    expect((await readFile(source)).equals(editedGbk)).toBe(true);
    await (await documentOptions(app.page)).getByRole('button', { name: '编码与换行', exact: true }).click();
    const lossDialog = app.page.getByRole('dialog', { name: '编码与换行', exact: true });
    await lossDialog.getByRole('combobox', { name: '目标编码', exact: true }).selectOption('windows-1252');
    await lossDialog.getByRole('button', { name: '应用转换', exact: true }).click();
    await expect(lossDialog.getByRole('heading', { name: '有 3 个字符无法无损表示' })).toBeVisible();
    await expect(lossDialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await lossDialog.getByRole('button', { name: '确认替换为 ? 并转换', exact: true }).click();
    await app.page.locator('.cm-content').focus(); await app.page.keyboard.press('Control+s');
    const accepted = Buffer.from('??\r\nsecond\nthird\rfourth\r\nadded?');
    await expect.poll(async () => (await readFile(source)).equals(accepted)).toBe(true);
    await expect(app.page.getByRole('tab', { selected: true })).toHaveAttribute('aria-description', /没有未保存修改/);
    await close(app.child);
    for (const instance of instances) expect(instance.diagnostics).toEqual([]);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable, executableSha256, executableBytes: (await stat(executable)).size,
      browserVersion: app.browser.version(), dataDir,
      scope: 'Real offline Release, native chooser and exact file/recovery bytes; one controlled encoding path, no business mocks',
      explicitGbkOpen: true, mixedNewlinesAndDominantInsertionPreserved: true, utf16BomAndLfBytesVerified: true,
      conversionUndoRestoresOriginalEncodingAndTokens: true, unconfirmedLossKeepsDiskBytes: true,
      unrepresentableUnicodeDraftPersistedAndRestarted: true, explicitLossConfirmationWritesOnlyAcceptedReplacements: true,
      originalSha256: sha(original), editedGbkSha256: sha(editedGbk), utf16Sha256: sha(utf16), finalSha256: sha(accepted),
    }, null, 2));
  } finally {
    for (const [index, app] of instances.entries()) {
      await writeFile(path.join(evidence, `diagnostics-${index}.json`), JSON.stringify(app.diagnostics));
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

import { documentOptions, menuItem, resumeEditing } from '../ui-actions';
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
interface Profile {
  version: number;
  settings: { documentLanguagePreferences?: { schemaVersion: number; entries: { key: string; languageId: string }[] } };
}

test('real Release preserves manual language across reopen, atomic save, SaveAs and fresh-profile restarts', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'language');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-language-'));
  const state = path.join(dataDir, 'featherpad-state');
  const root = path.join(dataDir, '语言 文件夹😀');
  await mkdir(root);
  const source = path.join(root, '手选语言.txt');
  const destination = path.join(root, '另存语言.sql');
  const draftPath = path.join(root, '草稿首次保存.txt');
  await writeFile(source, 'public class Main {}');
  const settingsFile = path.join(state, 'settings/settings.json');
  const profile = async () => {
    try { return JSON.parse(await readFile(settingsFile, 'utf8')) as Profile; }
    catch { return { version: 0, settings: {} } satisfies Profile; }
  };
  const instances: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>; diagnostics: unknown[] }[] = [];

  async function launch() {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No CDP port')); return; }
        server.close(() => resolve(address.port));
      });
    });
    const webviewProfile = await mkdtemp(path.join(dataDir, 'profile-'));
    const child = spawn(executable, [], { cwd: project, windowsHide: true, stdio: 'ignore', env: {
      ...process.env, FEATHERPAD_USER_DATA_DIR: state, WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    } });
    let launchError: Error | null = null;
    child.once('error', error => { launchError = error; });
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Native child exited ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const diagnostics: unknown[] = [];
    instances.push({ child, browser, diagnostics });
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') diagnostics.push({ type: message.type(), message: message.text() }); });
    page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: error.message }));
    page.on('requestfailed', request => diagnostics.push({ type: 'requestfailed', origin: new URL(request.url()).origin }));
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
    const chooser = new NativeChooser({ page, child, dataDir, executable, executableSha256, evidence, cleanupTasks: [] });
    return { page, child, chooser, browser };
  }

  async function closeNormally(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) throw new Error('Owned native process missing');
    const literal = `'${executable.replaceAll("'", "''")}'`;
    await runFile('powershell.exe', ['-NoProfile', '-Command',
      `$testProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; if ($testProcess.Path -ne ${literal}) { throw 'Owned executable mismatch' }; if (-not $testProcess.CloseMainWindow()) { throw 'WM_CLOSE was not sent' }`],
    { windowsHide: true, timeout: 10_000 });
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
  }

  try {
    let app = await launch();
    await (await menuItem(app.page, '打开文件夹')).click();
    await app.chooser.select('open-folder', root);
    await app.page.getByRole('treeitem', { name: '手选语言.txt', exact: true }).dblclick();
    await (await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('java'); await resumeEditing(app.page);
    await expect.poll(async () => (await profile()).settings.documentLanguagePreferences?.entries.map(entry => entry.languageId)).toEqual(['java']);
    await app.page.getByRole('button', { name: '关闭 手选语言.txt', exact: true }).click();
    await app.page.getByRole('treeitem', { name: '手选语言.txt', exact: true }).dblclick();
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('java');
    await app.page.waitForTimeout(500);
    const version = (await profile()).version;
    await app.page.locator('.cm-content').focus();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText('\n// saved');
    expect((await profile()).version).toBe(version);
    await app.page.keyboard.press('Control+s');
    await expect.poll(() => readFile(source, 'utf8')).toBe('public class Main {}\r\n// saved');
    await app.page.getByRole('button', { name: '关闭 手选语言.txt', exact: true }).click();
    await app.page.getByRole('treeitem', { name: '手选语言.txt', exact: true }).dblclick();
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('java');
    await (await menuItem(app.page, '另存为')).click();
    await app.chooser.select('save', destination);
    await expect(app.page.getByRole('tab', { name: '另存语言.sql', exact: true })).toBeVisible();
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('java');
    await expect.poll(async () => (await profile()).settings.documentLanguagePreferences?.entries.length).toBe(2);
    await (await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('auto'); await resumeEditing(app.page);
    await expect(app.page.getByRole('status')).toContainText('SQL');
    await expect.poll(async () => (await profile()).settings.documentLanguagePreferences?.entries.length).toBe(1);
    await (await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('json'); await resumeEditing(app.page);
    await app.page.getByRole('button', { name: '新建文本', exact: true }).click();
    await app.page.locator('.cm-content').focus();
    const draft = '{"private-draft": true}';
    await app.page.keyboard.insertText(draft);
    await (await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('jsonc'); await resumeEditing(app.page);
    const draftId = await app.page.getByRole('tab', { selected: true }).getAttribute('id');
    // Close immediately after the choice: production exit must drain pending language writes.
    await closeNormally(app.child);
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(2);
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('jsonc');
    await expect(app.page.locator('.cm-content')).toHaveText(draft);
    expect(await app.page.getByRole('tab', { selected: true }).getAttribute('id')).toBe(draftId);
    await app.page.getByRole('tab', { name: '另存语言.sql', exact: true }).click();
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('json');
    await app.page.locator(`[id="${draftId}"]`).click();
    await app.page.getByRole('button', { name: '保存', exact: true }).click();
    await app.chooser.select('save', draftPath);
    await expect(app.page.getByRole('tab', { name: '草稿首次保存.txt', exact: true })).toBeVisible();
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('jsonc');
    await app.page.getByRole('button', { name: '关闭 草稿首次保存.txt', exact: true }).click();
    await app.page.getByRole('button', { name: '打开文件', exact: true }).click();
    await app.chooser.select('open', draftPath);
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('jsonc');
    await (await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('auto'); await resumeEditing(app.page);
    await expect(app.page.getByRole('status')).toContainText('纯文本');
    await closeNormally(app.child);
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(2);
    await expect((await documentOptions(app.page)).getByRole('combobox', { name: '语言模式', exact: true })).toHaveValue('auto');
    await expect(app.page.locator('.cm-content')).toHaveText(draft);
    await app.page.screenshot({ path: path.join(evidence, 'language-restored-and-auto.png') });
    await closeNormally(app.child);
    const stored = (await profile()).settings.documentLanguagePreferences!;
    expect(stored.schemaVersion).toBe(1);
    for (const entry of stored.entries) expect(entry.key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('private-draft');
    expect(JSON.stringify(stored)).not.toContain(root);
    expect(await readFile(draftPath, 'utf8')).toBe(draft);
    expect(await readFile(destination, 'utf8')).toBe(await readFile(source, 'utf8'));
    for (const instance of instances) expect(instance.diagnostics).toEqual([]);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable, executableSha256, executableBytes: (await stat(executable)).size,
      browserVersion: app.browser.version(), dataDir,
      scope: 'Real offline Tauri Release and native choosers; fresh WebView2 profile each restart; no business mocks',
      reopenAndAtomicSaveRetainChoice: true, saveAsRetainsChoiceAndAutoRestoresDetection: true,
      untitledLanguageAndTextSurviveImmediateNormalExit: true, firstSaveRetainsChoice: true,
      autoPersistsAcrossRestart: true, noPerKeySettingsWrite: true, privateMetadataContainsOnlyHashesAndLanguageIds: true,
      sourceSha256: sha(await readFile(source)), destinationSha256: sha(await readFile(destination)),
      settingsSha256: sha(await readFile(settingsFile)), settingsVersion: (await profile()).version,
    }, null, 2));
  } finally {
    for (const [index, app] of instances.entries()) {
      await writeFile(path.join(evidence, `diagnostics-${index}.json`), JSON.stringify(app.diagnostics));
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface NativeApp {
  child: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

interface GrantRecord {
  grantId: string;
  kind: 'file' | 'directory';
  pathUtf16: number[];
  identitySha256: string;
}

const project = process.cwd();
const releaseExecutable = path.join(project, 'src-tauri/target/release/featherpad.exe');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function reservePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No local TCP port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<ProcessResult> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stdout, stderr });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process did not exit within ${timeoutMs}ms. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runProcess(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? project,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void waitForExit(child, options.timeoutMs).then(resolve, reject);
  });
}

async function launchApp(
  executable: string,
  options: {
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    profileRoot: string;
    windowsHide?: boolean;
  },
): Promise<NativeApp> {
  const port = await reservePort();
  const profile = await mkdtemp(path.join(options.profileRoot, 'webview2-profile-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  };
  if (options.stateDir) env.FEATHERPAD_USER_DATA_DIR = options.stateDir;
  const child = spawn(executable, options.args ?? [], {
    cwd: options.cwd ?? project,
    windowsHide: options.windowsHide ?? true,
    stdio: 'ignore',
    env,
  });
  let launchError: Error | null = null;
  child.once('error', error => { launchError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Native app exited before WebView2 startup: ${child.exitCode}`);
    try {
      return (await fetch(`${endpoint}/json/version`)).ok;
    } catch {
      return false;
    }
  }, { timeout: 20_000 }).toBe(true);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Native WebView2 context missing');
  await context.setOffline(true);
  await expect.poll(() => context.pages().length).toBeGreaterThan(0);
  const page = context.pages()[0];
  if (!page) throw new Error('Native WebView2 page missing');
  await expect(page).toHaveTitle('轻羽 FeatherPad');
  return { child, browser, context, page };
}

async function stopApp(app: NativeApp | undefined): Promise<void> {
  if (!app) return;
  if (app.browser.isConnected()) await app.browser.close().catch(() => undefined);
  if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
  await expect.poll(() => app.child.exitCode !== null || app.child.signalCode !== null).toBe(true);
}

function nativeInvoke<T>(page: Page, command: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
      invoke: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
    };
    return await native.invoke(command, args) as T;
  }, { command, args });
}

async function readGrantForFile(stateDir: string, target: string): Promise<GrantRecord> {
  const grantsFile = path.join(stateDir, 'session', 'grants.json');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(grantsFile, 'utf8')) as {
        grants: GrantRecord[];
      };
      const grant = parsed.grants.find(record => {
        if (record.kind !== 'file') return false;
        const stored = String.fromCharCode(...record.pathUtf16).replace(/^\\\\\?\\/, '');
        return path.resolve(stored).toLocaleLowerCase() === path.resolve(target).toLocaleLowerCase();
      });
      if (grant) return grant;
    } catch {
      // Session grants may not have been flushed yet; poll until the bounded deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Session grant was not persisted for ${target}`);
}

async function runGuiErrorDialog(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  expectedText: string,
): Promise<{ text: string; exitCode: number | null }> {
  const child = spawn(executable, args, {
    cwd: project,
    env: { ...process.env, ...env },
    windowsHide: false,
    stdio: 'ignore',
  });
  if (!child.pid) throw new Error('Unable to start native error-dialog fixture');
  try {
    const observed = await new Promise<{ text: string }>((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', path.join(project, 'scripts/Test-WindowsMessageBox.ps1'),
        '-TargetProcessId', String(child.pid),
        '-ExpectedText', expectedText,
        '-TimeoutSeconds', '20',
      ], { cwd: project, windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Native dialog probe failed: ${stderr || stdout || error.message}`));
          return;
        }
        resolve(JSON.parse(stdout) as { text: string });
      });
    });
    const result = await waitForExit(child, 15_000);
    return { text: observed.text, exitCode: result.code };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function registryQuery(key: string, value?: string): Promise<boolean> {
  const args = ['query', key];
  if (value) args.push('/v', value);
  const result = await runProcess('reg.exe', args, { timeoutMs: 10_000 });
  return result.code === 0;
}

async function registryData(key: string, value?: string): Promise<string | null> {
  const args = ['query', key];
  if (value) args.push('/v', value);
  const result = await runProcess('reg.exe', args, { timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout : null;
}

async function registryDelete(key: string, value?: string): Promise<void> {
  const args = value
    ? ['delete', key, '/v', value, '/f']
    : ['delete', key, '/f'];
  await runProcess('reg.exe', args, { timeoutMs: 10_000 });
}

test('M4 CLI, single instance and multi-window ownership use the real Release', async () => {
  test.setTimeout(300_000);
  const runRoot = path.join(project, '.artifacts/T401', randomUUID());
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-cli');
  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const stateDir = path.join(runRoot, 'state');
  const fixtures = path.join(runRoot, '中文 目录');
  await mkdir(fixtures, { recursive: true });
  const shared = path.join(fixtures, '共享 文档.md');
  const waitFile = path.join(fixtures, '等待 关闭.txt');
  const second = path.join(fixtures, '第二 文件.json');
  const missing = path.join(fixtures, '不存在.txt');
  await Promise.all([
    writeFile(shared, '第一行\r\n第二行\r\n第三行', 'utf8'),
    writeFile(waitFile, '--wait fixture\r\n', 'utf8'),
    writeFile(second, '{"second":true}\r\n', 'utf8'),
  ]);
  const originalHash = sha256(await readFile(shared));
  let app: NativeApp | undefined;
  try {
    const help = await runProcess(releaseExecutable, ['--help'], {
      env: { ...process.env, FEATHERPAD_USER_DATA_DIR: stateDir },
    });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--new-window');
    expect(help.stdout).toContain('--wait');
    expect(help.stdout).not.toContain('WebView');

    const conflict = await runProcess(releaseExecutable, [
      '--new-window', '--reuse-window', shared,
    ], { env: { ...process.env, FEATHERPAD_USER_DATA_DIR: stateDir } });
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain('不能同时使用');

    app = await launchApp(releaseExecutable, {
      stateDir,
      profileRoot: runRoot,
      windowsHide: true,
    });
    const routedEnvironment = { ...process.env, FEATHERPAD_USER_DATA_DIR: stateDir };
    const activate = await runProcess(releaseExecutable, [], { env: routedEnvironment });
    expect(activate.code).toBe(0);
    expect(app.context.pages()).toHaveLength(1);
    const goto = await runProcess(releaseExecutable, [
      '--reuse-window', '--goto', `${path.relative(project, shared)}:2:3`,
    ], { env: routedEnvironment });
    expect(goto.code).toBe(0);
    await expect(app.page.getByRole('tab', { name: '共享 文档.md', exact: true })).toBeVisible();
    await expect(app.page.getByRole('group', { name: '光标与字数', exact: true }))
      .toContainText('行 2，列 3');

    const waiting = spawn(releaseExecutable, ['--wait', waitFile], {
      cwd: project,
      env: routedEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await expect(app.page.getByRole('tab', { name: '等待 关闭.txt', exact: true })).toBeVisible();
    expect(waiting.exitCode).toBeNull();
    await app.page.keyboard.press('Control+w');
    const waitingResult = await waitForExit(waiting, 30_000);
    expect(waitingResult.code).toBe(0);

    const partial = await runProcess(releaseExecutable, [
      shared, missing, second,
    ], { env: routedEnvironment });
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('不存在.txt');
    await expect(app.page.getByRole('tab', { name: '第二 文件.json', exact: true })).toBeVisible();
    await expect(app.page.getByRole('tab', { name: '共享 文档.md', exact: true })).toBeVisible();
    await expect(app.page.getByRole('alert')).toContainText('不存在.txt');

    await app.page.getByRole('tab', { name: '共享 文档.md', exact: true }).click();
    await app.page.locator('.document-view .cm-content').focus();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText('\n主窗口未保存的独有正文');
    await expect.poll(async () => {
      const inventory = await nativeInvoke<{ ok: boolean; value: { entries: unknown[] } }>(
        app!.page, 'list_recovery_entries', {});
      return inventory.ok && inventory.value.entries.length > 0;
    }, { timeout: 20_000 }).toBe(true);
    const nextPage = app.context.waitForEvent('page', { timeout: 20_000 });
    const newWindow = await runProcess(releaseExecutable, ['--new-window', shared], {
      env: routedEnvironment,
    });
    expect(newWindow.code).toBe(0);
    const mirror = await nextPage;
    await expect(mirror.getByRole('tab', { name: '共享 文档.md', exact: true })).toBeVisible();
    await expect(mirror.getByRole('tab', { name: '第二 文件.json', exact: true })).toHaveCount(0);
    await expect(mirror.locator('.document-view .cm-content')).not.toContainText('主窗口未保存的独有正文');
    await expect(mirror.getByRole('status', { name: '应用状态', exact: true })).toContainText('只读');
    await expect(mirror.locator('.document-view .cm-content')).toHaveAttribute('contenteditable', 'false');

    const grant = await readGrantForFile(stateDir, shared);
    const mirrorSave = await mirror.evaluate(async ({ grant }) => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
      };
      const opened = await native.invoke('open_document', {
        ref: { grantId: grant.grantId, relativePath: '' },
      }) as {
        ok: boolean;
        value: {
          documentId: string;
          metadata: { diskRevision: string };
          format: Record<string, unknown>;
          content: { kind: string; text: string; newlineMap: { documentVersion: number; endings: string[] } };
          writable: boolean;
        };
      };
      if (!opened.ok || opened.value.content.kind !== 'text') throw new Error('Mirror native open failed');
      const denied = await native.invoke('save_document', {
        documentId: opened.value.documentId,
        requestId: crypto.randomUUID(),
        documentVersion: 1,
        expectedDiskRevision: opened.value.metadata.diskRevision,
        text: `${opened.value.content.text}\n镜像越权写入`,
        format: opened.value.format,
        newlineMap: { documentVersion: 1, endings: opened.value.content.newlineMap.endings },
      });
      const reloaded = await native.invoke('reload_document', {
        documentId: opened.value.documentId, expectedDiskRevision: opened.value.metadata.diskRevision,
      });
      const guarded = await Promise.all([
        native.invoke('reopen_with_encoding', { documentId: opened.value.documentId,
          encoding: 'utf-8', expectedDiskRevision: opened.value.metadata.diskRevision }),
        native.invoke('discard_recovery', { documentId: opened.value.documentId, throughVersion: 1 }),
        native.invoke('write_recovery_snapshot', { documentId: opened.value.documentId,
          documentVersion: 1, reason: 'periodic', baseDiskRevision: opened.value.metadata.diskRevision,
          text: opened.value.content.text, format: opened.value.format,
          newlineMap: { documentVersion: 1, endings: opened.value.content.newlineMap.endings } }),
      ]);
      return { writable: opened.value.writable, denied, reloaded, guarded };
    }, { grant });
    expect(mirrorSave.writable).toBe(false);
    expect(mirrorSave.denied).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(mirrorSave.reloaded).toMatchObject({ ok: true, value: { writable: false } });
    for (const denied of mirrorSave.guarded) {
      expect(denied).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
    expect(sha256(await readFile(shared))).toBe(originalHash);

    await expect.poll(async () => {
      const loaded = await nativeInvoke<{
        ok: boolean;
        value?: { session: { windows: { windowId: string }[] } | null };
      }>(mirror, 'load_session', {});
      return loaded.ok ? loaded.value?.session?.windows.length ?? 0 : 0;
    }, { timeout: 20_000 }).toBe(2);
    const mirrorLabel = await mirror.evaluate(() => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        metadata: { currentWindow: { label: string } };
      };
      return native.metadata.currentWindow.label;
    });
    expect(mirrorLabel).toMatch(/^window-/);
    const removed = await nativeInvoke<{ ok: boolean; value: { removed: boolean } }>(
      mirror, 'remove_desktop_window_session', {},
    );
    expect(removed).toMatchObject({ ok: true, value: { removed: true } });
    await expect.poll(async () => {
      const loaded = await nativeInvoke<{
        ok: boolean;
        value?: { session: { windows: { windowId: string }[] } | null };
      }>(app!.page, 'load_session', {});
      return loaded.ok ? loaded.value?.session?.windows.map(window => window.windowId) ?? [] : [];
    }, { timeout: 20_000 }).toEqual(['main']);

    await app.page.screenshot({ path: path.join(evidence, 'owner-window.png') });
    await mirror.screenshot({ path: path.join(evidence, 'readonly-mirror.png') });
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: releaseExecutable,
      executableSha256: sha256(await readFile(releaseExecutable)),
      helpWithoutWebView: true,
      noArgumentSecondLaunchActivatesExistingWindow: true,
      gotoLineColumn: true,
      waitClosedWithExitZero: true,
      partialPathsExitOneAndOpenValidTargets: true,
      secondWindowOwnsNoWriteLease: true,
      mirrorSaveRejectedAsConflict: true,
      sourceSha256Unchanged: originalHash,
      mergedSessionWindowsBeforeRemoval: 2,
      sessionAfterRemoval: ['main'],
    }, null, 2));
  } finally {
    await stopApp(app);
  }
});

test('M4 installer launches, upgrades and uninstalls without deleting user data', async () => {
  test.setTimeout(300_000);
  const runRoot = path.join(project, '.artifacts/T402', `m4-install-${randomUUID()}`);
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-installer');
  const installRoot = path.join(runRoot, 'installed');
  const localAppData = path.join(runRoot, 'local-app-data');
  const dataRoot = path.join(localAppData, 'app.featherpad.desktop');
  const profileRoot = path.join(runRoot, 'profiles');
  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const sentinel = path.join(dataRoot, `M4-preserve-${randomUUID()}.txt`);
  await writeFile(sentinel, 'installer acceptance sentinel\r\n', 'utf8');
  const sentinelHash = sha256(await readFile(sentinel));
  const bundleRoot = path.join(project, 'src-tauri/target/release/bundle/nsis');
  const installerName = (await readdir(bundleRoot))
    .filter(name => name.endsWith('-setup.exe'))
    .sort()
    .at(-1);
  if (!installerName) throw new Error('NSIS installer is missing');
  const installer = path.join(bundleRoot, installerName);
  let app: NativeApp | undefined;
  try {
    const installed = await runProcess(installer, ['/S', `/D=${installRoot}`], { timeoutMs: 120_000 });
    expect(installed.code).toBe(0);
    const installedExe = path.join(installRoot, 'featherpad.exe');
    const uninstaller = path.join(installRoot, 'uninstall.exe');
    await expect.poll(async () => (await stat(installedExe)).isFile(), { timeout: 30_000 }).toBe(true);
    const installedExecutableHash = sha256(await readFile(installedExe));
    expect((await stat(uninstaller)).isFile()).toBe(true);

    app = await launchApp(installedExe, {
      profileRoot, cwd: installRoot,
      env: { LOCALAPPDATA: localAppData, PATH: `${process.env.SystemRoot}\\System32` },
      windowsHide: true,
    });
    const status = await nativeInvoke<{
      ok: boolean;
      value: { runtimeMode: string; dataRoot: string; changesDefaultApp: boolean };
    }>(app.page, 'get_desktop_integration', {});
    expect(status).toMatchObject({
      ok: true,
      value: { runtimeMode: 'installed', changesDefaultApp: false },
    });
    expect(path.resolve(status.value.dataRoot).toLocaleLowerCase())
      .toBe(path.resolve(dataRoot).toLocaleLowerCase());
    expect(await registryQuery('HKCU\\Software\\Classes\\FeatherPad.Text')).toBe(false);
    const enabled = await nativeInvoke<{ ok: boolean }>(app.page, 'set_desktop_integration', {
      request: { fileAssociation: true, contextMenu: true },
    });
    expect(enabled.ok).toBe(true);
    const blockedUninstall = await runProcess(uninstaller, ['/S', `_?=${installRoot}`], { timeoutMs: 30_000 });
    expect(blockedUninstall.code).toBe(2);
    expect(app.child.exitCode).toBeNull();
    expect(await registryQuery('HKCU\\Software\\Classes\\FeatherPad.Text')).toBe(true);
    await stopApp(app);
    app = undefined;

    const upgrade = await runProcess(installer, ['/S', `/D=${installRoot}`], { timeoutMs: 120_000 });
    expect(upgrade.code).toBe(0);
    expect(sha256(await readFile(sentinel))).toBe(sentinelHash);
    expect(await registryData('HKCU\\Software\\Classes\\FeatherPad.Text\\shell\\open\\command'))
      .toContain(installedExe);

    const uninstall = await runProcess(uninstaller, ['/S'], { timeoutMs: 120_000 });
    expect(uninstall.code).toBe(0);
    await expect.poll(async () => {
      try {
        return await stat(path.join(installRoot, 'featherpad.exe')).then(() => false, () => true);
      } catch {
        return true;
      }
    }, { timeout: 30_000 }).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('installer acceptance sentinel\r\n');
    expect(await registryQuery('HKCU\\Software\\Classes\\FeatherPad.Text')).toBe(false);
    expect(await registryQuery('HKCU\\Software\\Classes\\Applications\\featherpad.exe')).toBe(false);
    expect(await registryQuery('HKCU\\Software\\Classes\\Directory\\shell\\FeatherPad')).toBe(false);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      installer,
      installerSha256: sha256(await readFile(installer)),
      installedExecutableSha256: installedExecutableHash,
      controlledInstallRoot: installRoot,
      controlledLocalAppData: localAppData,
      installedRuntimeMode: status.value.runtimeMode,
      installedDataRoot: status.value.dataRoot,
      changesDefaultApp: status.value.changesDefaultApp,
      silentUpgradeSucceeded: true,
      silentUninstallSucceeded: true,
      uninstallWhileRunningRefusedWithoutKillingEditor: true,
      optInAssociationsRetainedAcrossUpgradeAndRemovedOnUninstall: true,
      productDataSentinelPreserved: sentinel,
      productDataSentinelSha256: sentinelHash,
    }, null, 2));
  } finally {
    await stopApp(app);
    if (await stat(path.join(installRoot, 'uninstall.exe')).then(() => true, () => false)) {
      await runProcess(path.join(installRoot, 'uninstall.exe'), ['/S'], { timeoutMs: 120_000 }).catch(() => undefined);
    }
  }
});

test('M4 portable data isolation, restart and error guidance use real files', async () => {
  test.setTimeout(300_000);
  const runRoot = path.join(project, '.artifacts/T403', `m4-portable-${randomUUID()}`);
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-portable');
  const portableRoot = path.join(runRoot, '轻羽 便携版');
  const profileRoot = path.join(runRoot, 'profiles');
  const localAppData = path.join(runRoot, 'local-app-data');
  const installedData = path.join(localAppData, 'app.featherpad.desktop');
  await Promise.all([
    mkdir(portableRoot, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
    mkdir(installedData, { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const portableExe = path.join(portableRoot, 'featherpad.exe');
  await copyFile(releaseExecutable, portableExe);
  await writeFile(path.join(portableRoot, 'portable.flag'), 'FeatherPad portable mode\r\n', 'utf8');
  const installSentinel = path.join(installedData, 'must-stay-untouched.txt');
  await writeFile(installSentinel, 'installed data only\r\n', 'utf8');
  const installSentinelHash = sha256(await readFile(installSentinel));
  let app: NativeApp | undefined;
  try {
    app = await launchApp(portableExe, {
      cwd: portableRoot,
      profileRoot,
      env: { LOCALAPPDATA: localAppData },
      windowsHide: true,
    });
    const portableData = path.join(portableRoot, 'data');
    const status = await nativeInvoke<{
      ok: boolean;
      value: { runtimeMode: string; dataRoot: string; executablePath: string };
    }>(app.page, 'get_desktop_integration', {});
    expect(status).toMatchObject({ ok: true, value: { runtimeMode: 'portable' } });
    expect(path.resolve(status.value.dataRoot).toLocaleLowerCase())
      .toBe(path.resolve(portableData).toLocaleLowerCase());
    expect(path.resolve(status.value.executablePath).toLocaleLowerCase())
      .toBe(path.resolve(portableExe).toLocaleLowerCase());

    const loaded = await nativeInvoke<{
      ok: boolean;
      value: { version: number; revision: string | null; settings: Record<string, unknown> };
    }>(app.page, 'load_settings', {});
    expect(loaded.ok).toBe(true);
    const saved = await nativeInvoke<{
      ok: boolean;
      value: { version: number; revision: string | null };
    }>(app.page, 'save_settings', {
      expectedVersion: loaded.value.version,
      expectedRevision: loaded.value.revision,
      settings: { ...loaded.value.settings, theme: 'light', fontSize: 17 },
    });
    expect(saved).toMatchObject({ ok: true });
    await app.page.getByRole('button', { name: '新建文本', exact: true }).click();
    await expect(app.page.locator('.document-view .cm-content')).toBeVisible();
    await expect.poll(async () => {
      try {
        return await stat(path.join(portableData, 'session', 'manifest.json')).then(() => true, () => false);
      } catch {
        return false;
      }
    }, { timeout: 15_000 }).toBe(true);
    await stopApp(app);
    app = undefined;

    app = await launchApp(portableExe, {
      cwd: portableRoot,
      profileRoot,
      env: { LOCALAPPDATA: localAppData },
      windowsHide: true,
    });
    const restored = await nativeInvoke<{
      ok: boolean;
      value: { settings: { theme: string; fontSize: number } };
    }>(app.page, 'load_settings', {});
    expect(restored).toMatchObject({
      ok: true,
      value: { settings: { theme: 'light', fontSize: 17 } },
    });
    await stopApp(app);
    app = undefined;
    expect(sha256(await readFile(installSentinel))).toBe(installSentinelHash);
    const portableEntries = await readdir(portableData);
    expect(portableEntries).toContain('settings');
    expect(portableEntries).toContain('session');

    const markerDirectoryRoot = path.join(runRoot, 'bad-marker');
    await mkdir(path.join(markerDirectoryRoot, 'portable.flag'), { recursive: true });
    await copyFile(releaseExecutable, path.join(markerDirectoryRoot, 'featherpad.exe'));
    const markerError = await runGuiErrorDialog(
      path.join(markerDirectoryRoot, 'featherpad.exe'),
      [],
      { FEATHERPAD_USER_DATA_DIR: path.join(runRoot, 'bad-marker-state') },
      'portable.flag 必须是普通文件',
    );
    expect(markerError.exitCode).toBe(1);

    const dataFileRoot = path.join(runRoot, 'data-is-file');
    await mkdir(dataFileRoot, { recursive: true });
    await copyFile(releaseExecutable, path.join(dataFileRoot, 'featherpad.exe'));
    await writeFile(path.join(dataFileRoot, 'portable.flag'), 'portable\r\n', 'utf8');
    await writeFile(path.join(dataFileRoot, 'data'), 'not a directory\r\n', 'utf8');
    const dataError = await runGuiErrorDialog(
      path.join(dataFileRoot, 'featherpad.exe'),
      [],
      {},
      '便携模式数据目录不可用或不可写',
    );
    expect(dataError.exitCode).toBe(1);

    const missingRuntimeState = path.join(runRoot, 'missing-runtime-state');
    const missingLocalAppData = path.join(runRoot, 'missing-runtime-local');
    const missingRuntime = await runGuiErrorDialog(
      releaseExecutable,
      [],
      {
        FEATHERPAD_USER_DATA_DIR: missingRuntimeState,
        LOCALAPPDATA: missingLocalAppData,
        'ProgramFiles(x86)': missingLocalAppData,
        WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: missingLocalAppData,
      },
      'https://developer.microsoft.com/microsoft-edge/webview2/#download-section',
    );
    expect(missingRuntime.exitCode).toBe(1);

    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: portableExe,
      executableSha256: sha256(await readFile(portableExe)),
      marker: path.join(portableRoot, 'portable.flag'),
      runtimeMode: status.value.runtimeMode,
      portableDataRoot: portableData,
      installedDataRoot: installedData,
      installedDataSentinelSha256: installSentinelHash,
      installedDataUnchanged: true,
      restartedTheme: restored.value.settings.theme,
      restartedFontSize: restored.value.settings.fontSize,
      invalidMarkerShowsNativeError: markerError.text,
      invalidDataShowsNativeError: dataError.text,
      missingWebView2ShowsOfflineGuidance: missingRuntime.text,
    }, null, 2));
  } finally {
    await stopApp(app);
  }
});

test('M4 opt-in Explorer integration never changes UserChoice and removes only own entries', async () => {
  test.setTimeout(240_000);
  const runRoot = path.join(project, '.artifacts/T404', randomUUID());
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-integration');
  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const stateDir = path.join(runRoot, 'state');
  const progKey = 'HKCU\\Software\\Classes\\FeatherPad.Text';
  const appKey = 'HKCU\\Software\\Classes\\Applications\\featherpad.exe';
  const userChoiceKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\UserChoice';
  const supportedExtensions = [
    '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml',
    '.toml', '.xml', '.csv', '.log', '.ini', '.conf', '.sql',
  ];
  const candidateKeys = supportedExtensions.map(extension =>
    `HKCU\\Software\\Classes\\${extension}\\OpenWithProgids`);
  const menuKeys = supportedExtensions.map(extension =>
    `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell\\FeatherPad`);
  const directoryMenu = 'HKCU\\Software\\Classes\\Directory\\shell\\FeatherPad';
  const initialUserChoice = await registryData(userChoiceKey, 'ProgId');
  expect(await registryQuery(progKey)).toBe(false);
  expect(await registryQuery(appKey)).toBe(false);
  for (const key of [...menuKeys, directoryMenu]) expect(await registryQuery(key)).toBe(false);
  for (const key of candidateKeys) expect(await registryQuery(key, 'FeatherPad.Text')).toBe(false);
  let app: NativeApp | undefined;
  let created = false;
  try {
    app = await launchApp(releaseExecutable, {
      stateDir,
      profileRoot: runRoot,
      windowsHide: true,
    });
    await app.page.getByRole('button', { name: '打开设置', exact: true }).click();
    const settings = app.page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('tab', { name: '系统', exact: true }).click();
    const integration = settings.getByRole('region', { name: 'Windows 系统集成', exact: true });
    await expect(integration).toContainText('两项均默认关闭');
    await expect(integration).toContainText('不会修改 Windows 默认应用或 UserChoice');
    await expect(integration).toContainText(releaseExecutable);
    const checkboxes = integration.getByRole('checkbox');
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.nth(0)).not.toBeChecked();
    await expect(checkboxes.nth(1)).not.toBeChecked();
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await expect(checkboxes.nth(0)).toBeChecked();
    await expect(checkboxes.nth(1)).toBeChecked();
    created = true;
    await integration.getByRole('button', { name: '更新系统集成', exact: true }).click();
    await expect(integration.getByRole('status'))
      .toContainText('系统集成已按选择更新', { timeout: 30_000 });
    await expect(checkboxes.nth(0)).toBeChecked();
    await expect(checkboxes.nth(1)).toBeChecked();

    expect(await registryQuery(progKey, 'FeatherPadManaged')).toBe(true);
    expect(await registryQuery(appKey, 'FeatherPadManaged')).toBe(true);
    expect(await registryData(`${progKey}\\shell\\open\\command`))
      .toContain(releaseExecutable);
    expect(await registryData(`${appKey}\\shell\\open\\command`))
      .toContain(releaseExecutable);
    for (const key of candidateKeys) expect(await registryQuery(key, 'FeatherPad.Text')).toBe(true);
    for (const key of [...menuKeys, directoryMenu]) {
      expect(await registryData(`${key}\\command`)).toContain(releaseExecutable);
    }
    expect(await registryData(userChoiceKey, 'ProgId')).toBe(initialUserChoice);

    // Simulate another application repurposing the ProgID after opt-in.
    const changed = await runProcess('reg.exe', [
      'add', `${progKey}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ',
      '/d', `"C:\\Windows\\System32\\cmd.exe" /d /c echo "${releaseExecutable}" "%1"`, '/f',
    ], { timeoutMs: 10_000 });
    expect(changed.code).toBe(0);
    const changedStatus = await nativeInvoke<{ ok: boolean; value: { fileAssociation: boolean } }>(
      app.page, 'get_desktop_integration', {});
    expect(changedStatus).toMatchObject({ ok: true, value: { fileAssociation: false } });
    const conflict = await nativeInvoke<{ ok: boolean; error: { code: string } }>(
      app.page, 'set_desktop_integration', { request: { fileAssociation: true, contextMenu: true } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await checkboxes.nth(0).uncheck();
    await checkboxes.nth(1).uncheck();
    await integration.getByRole('button', { name: '更新系统集成', exact: true }).click();
    await expect(integration.getByRole('status'))
      .toContainText('系统集成已按选择更新', { timeout: 30_000 });
    expect(await registryData(`${progKey}\\shell\\open\\command`))
      .toContain('cmd.exe');
    expect(await registryQuery(appKey)).toBe(false);
    for (const key of [...menuKeys, directoryMenu]) expect(await registryQuery(key)).toBe(false);
    expect(await registryData(userChoiceKey, 'ProgId')).toBe(initialUserChoice);

    await app.page.screenshot({ path: path.join(evidence, 'integration-settings.png') });
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: releaseExecutable,
      executableSha256: sha256(await readFile(releaseExecutable)),
      optInDefaultOff: true,
      userChoiceBefore: initialUserChoice,
      userChoiceAfter: await registryData(userChoiceKey, 'ProgId'),
      userChoiceUnchanged: true,
      programIdOwnedMarker: 'app.featherpad.desktop',
      extensionCandidatesWritten: candidateKeys,
      contextMenusWritten: [...menuKeys, directoryMenu],
      changedThirdPartyCommandWasNotOverwritten: true,
      contextMenusRemoved: true,
      applicationEntryRemoved: true,
    }, null, 2));
  } finally {
    await stopApp(app);
    if (created) {
      await registryDelete(progKey);
      await registryDelete(appKey);
      for (const key of candidateKeys) await registryDelete(key, 'FeatherPad.Text');
      for (const key of [...menuKeys, directoryMenu]) await registryDelete(key);
    }
  }
});


test('M4 uninstaller data cleanup removes owned files and refuses junction traversal', async () => {
  test.setTimeout(60_000);
  const runRoot = path.join(project, '.artifacts/T405', `uninstall-cleanup-${randomUUID()}`);
  const ordinary = path.join(runRoot, 'ordinary-data');
  const linked = path.join(runRoot, 'linked-data');
  const external = path.join(runRoot, 'outside-product-data');
  for (const directory of [ordinary, linked, external]) {
    expect(path.resolve(directory).startsWith(`${path.resolve(runRoot)}${path.sep}`)).toBe(true);
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(ordinary, 'recovery.txt'), 'explicitly discarded fixture', 'utf8');
  const sentinel = path.join(external, 'preserve.txt');
  await writeFile(sentinel, 'junction target must survive', 'utf8');
  await symlink(external, path.join(linked, 'junction'), 'junction');
  const setup = path.join(runRoot, 'cleanup-setup.exe');
  const uninstall = path.join(runRoot, 'cleanup-uninstall.exe');
  const result = path.join(runRoot, 'cleanup-result.txt');
  const script = path.join(runRoot, 'cleanup.nsi');
  await writeFile(script, `Unicode true
RequestExecutionLevel user
!include "LogicLib.nsh"
!include "${path.join(project, 'src-tauri/windows/uninstall-data.nsh')}"
OutFile "${setup}"
SilentInstall silent
SilentUnInstall silent
Section
  WriteUninstaller "${uninstall}"
SectionEnd
Section Uninstall
  StrCpy $FeatherPadCleanupFailed 0
  Push "${ordinary}"
  Call un.FeatherPadRemoveData
  FileOpen $9 "${result}" w
  FileWrite $9 "$FeatherPadCleanupFailed"
  StrCpy $FeatherPadCleanupFailed 0
  Push "${linked}"
  Call un.FeatherPadRemoveData
  FileWrite $9 "$FeatherPadCleanupFailed"
  FileClose $9
SectionEnd
`, 'utf8');
  const compiled = await runProcess(path.join(project, 'src-tauri/target/.tauri/NSIS/makensis.exe'),
    ['/V2', script]);
  expect(compiled.code, compiled.stdout + compiled.stderr).toBe(0);
  expect((await runProcess(setup, ['/S'])).code).toBe(0);
  expect((await runProcess(uninstall, ['/S'])).code).toBe(0);
  await expect.poll(() => readFile(result, 'utf8').catch(() => '')).toBe('01');
  expect(await stat(ordinary).then(() => true, () => false)).toBe(false);
  expect(await readFile(sentinel, 'utf8')).toBe('junction target must survive');
  expect((await stat(path.join(linked, 'junction'))).isDirectory()).toBe(true);
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-cleanup');
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), ordinaryDataRemoved: true,
    junctionRetained: true, outsideSentinelUnchanged: true,
    productionNsisFunction: 'src-tauri/windows/uninstall-data.nsh',
    scope: 'real NSIS harness using the production cleanup function, not installer UI automation',
  }, null, 2));
});


test('M4 first-instance CLI wait ends when its document closes while the GUI remains usable', async () => {
  test.setTimeout(90_000);
  const runRoot = path.join(project, '.artifacts/T401', `first-wait-${randomUUID()}`);
  await mkdir(runRoot, { recursive: true });
  const target = path.join(runRoot, 'first-wait.txt');
  await writeFile(target, 'first instance wait fixture', 'utf8');
  let app: NativeApp | undefined;
  try {
    app = await launchApp(releaseExecutable, {
      args: ['--wait', path.basename(target)], cwd: runRoot, stateDir: path.join(runRoot, 'state'),
      profileRoot: runRoot, windowsHide: true,
    });
    await expect(app.page.getByRole('tab', { name: 'first-wait.txt', exact: true })).toBeVisible();
    expect(app.child.exitCode).toBeNull();
    await app.page.keyboard.press('Control+w');
    expect((await waitForExit(app.child)).code).toBe(0);
    await expect(app.page.getByRole('button', { name: '新建文本', exact: true })).toBeEnabled();
    const lastSession = await nativeInvoke<{ ok: boolean; value: { removed: boolean } }>(
      app.page, 'remove_desktop_window_session', {});
    expect(lastSession).toMatchObject({ ok: true, value: { removed: false } });
    expect(await readFile(target, 'utf8')).toBe('first instance wait fixture');
    const evidence = path.join(project, '.artifacts/native',
      evidenceRunId(test.info().config.metadata.evidenceRunId), 'm4-first-wait');
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executableSha256: sha256(await readFile(releaseExecutable)),
      firstInstanceWaitClosedWithExitZero: true, guiRemainsUsable: true,
      lastWindowSessionRemovalRefused: true, sourceBytesUnchanged: true,
    }, null, 2));
  } finally {
    if (app && !app.page.isClosed()) {
      await nativeInvoke(app.page, 'plugin:window|destroy', { label: 'main' }).catch(() => undefined);
    }
    await stopApp(app);
  }
});

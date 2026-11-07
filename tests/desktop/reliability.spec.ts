import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const helper = path.resolve('scripts/Test-GlobalShortcut.ps1');
const editor = (page: Page) => page.locator('.document-view .cm-content');

interface StoredGrant {
  grantId: string;
  kind: 'file' | 'directory';
  pathUtf16: number[];
}

interface LaunchedApp {
  page: Page;
  child: ChildProcess;
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  chooser: NativeChooser;
  dataDir: string;
  state: string;
  evidence: string;
}

function decodeWindowsPath(units: number[]) {
  let result = '';
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[++index]!;
      result += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
    } else {
      result += String.fromCharCode(unit);
    }
  }
  return result;
}

async function storedDirectoryGrant(state: string, root: string) {
  const manifest = JSON.parse(await readFile(path.join(state, 'session/grants.json'), 'utf8')) as {
    grants: StoredGrant[];
  };
  const expected = path.resolve(root);
  const grant = manifest.grants.find(candidate => candidate.kind === 'directory'
    && path.resolve(decodeWindowsPath(candidate.pathUtf16).replace(/^\\\\\?\\/, '')) === expected);
  if (!grant) throw new Error('Native directory grant was not persisted');
  return { grantId: grant.grantId, relativePath: '' };
}

async function launchNative(
  project: string,
  testInfo: TestInfo,
  name: string,
  executable: string,
  executableSha256: string,
): Promise<LaunchedApp> {
  const dataDir = await mkdtemp(path.join(project, '.artifacts/T002', `webview2-${name}-`));
  const state = path.join(dataDir, 'featherpad-state');
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(testInfo.config.metadata.evidenceRunId), name);
  await mkdir(evidence, { recursive: true });
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No CDP port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  const profile = await mkdtemp(path.join(dataDir, 'profile-'));
  const child = spawn(executable, [], {
    cwd: project,
    windowsHide: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      FEATHERPAD_USER_DATA_DIR: state,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  let launchError: Error | null = null;
  child.once('error', error => { launchError = error; });
  await expect.poll(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, { timeout: 15_000 }).toBe(true);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  await context.setOffline(true);
  await expect.poll(() => context.pages().length).toBeGreaterThan(0);
  const page = context.pages()[0]!;
  await expect(page).toHaveTitle('轻羽 FeatherPad');
  expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
  const chooser = new NativeChooser({
    page,
    child,
    dataDir,
    executable,
    executableSha256,
    evidence,
    cleanupTasks: [],
  });
  return { page, child, browser, chooser, dataDir, state, evidence };
}

async function launchOwned(project: string, testInfo: TestInfo, name: string) {
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableBytes = await readFile(executable);
  const executableStat = await stat(executable);
  return {
    ...await launchNative(project, testInfo, name, executable, sha256(executableBytes)),
    executable,
    executableBytes: executableStat.size,
    executableSha256: sha256(executableBytes),
  };
}

async function runHelper(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-File', helper, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`Global-shortcut helper exited ${code}: ${stderr || stdout}`)));
  });
}

async function holdShortcut(shortcut: string) {
  const child = spawn('powershell.exe', ['-NoProfile', '-File', helper, '-Action', 'HoldConflict',
    '-Shortcut', shortcut], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const ready = await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`External shortcut reservation timed out: ${stderr}`)), 8_000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (!String(chunk).includes('READY')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`External shortcut helper exited ${code}: ${stderr}`));
    });
  });
  await ready;
  return async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
  };
}

async function stop(app: LaunchedApp) {
  if (app.browser.isConnected()) await app.browser.close().catch(() => {});
  if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
  await expect.poll(() => app.child.exitCode !== null || app.child.signalCode !== null).toBe(true);
}

test('real Release cross-file replacement previews without writes, commits, rolls back, and fences rollback conflicts', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  let app: Awaited<ReturnType<typeof launchOwned>> | undefined;
  try {
    app = await launchOwned(project, test.info(), 'M2 cross-file replacement');
    const folder = path.join(app.dataDir, 'M2 replacement workspace');
    await mkdir(folder);
    const ready = path.join(folder, 'ready.txt');
    const dirty = path.join(folder, 'dirty.txt');
    const utf16 = path.join(folder, 'utf16.txt');
    const conflict = path.join(folder, 'conflict.txt');
    const original = 'replace-token ready\n';
    const dirtyOriginal = 'replace-token dirty\n';
    const utf16Bom = Buffer.from([0xff, 0xfe]);
    const utf16Original = Buffer.concat([utf16Bom, Buffer.from('replace-token wide\r\n中文', 'utf16le')]);
    const utf16Replaced = Buffer.concat([utf16Bom, Buffer.from('replace-result wide\r\n中文', 'utf16le')]);
    await writeFile(ready, original, 'utf8');
    await writeFile(dirty, dirtyOriginal, 'utf8');
    await writeFile(utf16, utf16Original);
    await writeFile(conflict, 'conflict-token original\n', 'utf8');

    await app.page.locator('button[aria-keyshortcuts="Control+Shift+E"]').click();
    await app.chooser.select('open-folder', folder);
    const tree = app.page.locator('[data-workspace-tree]');
    await tree.getByRole('treeitem', { name: 'dirty.txt', exact: true }).click();
    await expect(editor(app.page)).toHaveText(dirtyOriginal);
    await editor(app.page).focus();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText(' unsaved buffer');
    await expect(app.page.getByRole('tab', { name: /dirty\.txt/ }).locator('.dirty-marker'))
      .toHaveAttribute('aria-label', '有未保存修改');

    await app.page.locator('button[aria-keyshortcuts="Control+Shift+F"]').click();
    const search = app.page.locator('.workspace-search-panel');
    await search.getByLabel('搜索内容', { exact: true }).fill('replace-token');
    await search.getByLabel('替换为', { exact: true }).fill('replace-result');
    await search.getByRole('button', { name: '预览跨文件替换', exact: true }).click();
    const dialog = app.page.locator('.replace-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('section[data-replace-state="ready"]')).toHaveCount(2);
    await expect(dialog.locator('section[data-replace-state="dirtySkipped"]')).toHaveCount(1);
    await expect(dialog).toContainText('未保存缓冲');
    expect(await readFile(ready, 'utf8')).toBe(original);
    expect(await readFile(dirty, 'utf8')).toBe(dirtyOriginal);
    expect(await readFile(utf16)).toEqual(utf16Original);
    const continueToConfirmation = dialog.getByRole('button', { name: '继续到最终确认', exact: true });
    await expect(continueToConfirmation).toBeEnabled();
    await continueToConfirmation.click({ timeout: 10_000 });
    await expect(dialog).toContainText('取消不会修改任何源文件');
    expect(await readFile(ready, 'utf8')).toBe(original);
    expect(await readFile(dirty, 'utf8')).toBe(dirtyOriginal);
    expect(await readFile(utf16)).toEqual(utf16Original);
    await app.page.screenshot({ path: path.join(app.evidence, 'replacement-final-confirmation.png') });
    await dialog.getByRole('button', { name: '确认替换并写入磁盘', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '替换完成', exact: true })).toBeVisible();
    expect(await readFile(ready, 'utf8')).toBe('replace-result ready\n');
    expect(await readFile(dirty, 'utf8')).toBe(dirtyOriginal);
    expect(await readFile(utf16)).toEqual(utf16Replaced);
    await expect(editor(app.page)).toContainText('unsaved buffer');

    await dialog.getByRole('button', { name: '回滚本次替换', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '回滚完成', exact: true })).toBeVisible();
    expect(await readFile(ready, 'utf8')).toBe(original);
    expect(await readFile(utf16)).toEqual(utf16Original);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();

    const rootGrant = await storedDirectoryGrant(app.state, folder);
    const plan = await app.page.evaluate(async grant => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('create_replace_plan', {
        requestId: crypto.randomUUID(), roots: [grant], pattern: 'conflict-token',
        replacement: 'conflict-result', isRegex: false, isCaseSensitive: true, isWholeWord: false,
        include: ['conflict.txt'], exclude: [], respectGitignore: false,
        followDirectoryLinks: false, includeHidden: false, dirtyPaths: [],
      });
    }, rootGrant) as {
      ok: boolean;
      value?: {
        planId: string;
        confirmationToken: string;
        files: { ref: { grantId: string; relativePath: string } }[];
      };
      error?: { message: string };
    };
    expect(plan.ok, plan.error?.message).toBe(true);
    const selected = [plan.value!.files[0]!.ref];
    const commit = await app.page.evaluate(async request => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('commit_replace_plan', request);
    }, { planId: plan.value!.planId, confirmationToken: plan.value!.confirmationToken, selected });
    expect(commit).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(await readFile(conflict, 'utf8')).toBe('conflict-result original\n');
    await writeFile(conflict, 'edited after replacement\n', 'utf8');
    const rollback = await app.page.evaluate(async batchId => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('rollback_replace_batch', { batchId });
    }, plan.value!.planId);
    expect(rollback).toMatchObject({
      ok: true,
      value: { status: 'failed', restored: [], conflicts: [expect.stringContaining('conflict.txt')] },
    });
    expect(await readFile(conflict, 'utf8')).toBe('edited after replacement\n');

    await writeFile(path.join(app.evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: app.executable,
      executableBytes: app.executableBytes,
      executableSha256: app.executableSha256,
      dataDir: app.dataDir,
      scope: 'Real Release, native folder chooser, native replacement service and actual source bytes; Playwright drives WebView2',
      previewAndFinalConfirmationWriteNothing: true,
      dirtyBufferExcludedAndPreserved: true,
      committedBytesVerified: true,
      utf16BomEncodingAndNewlinesPreserved: true,
      rollbackRestoredOriginalBytes: true,
      postCommitEditRejectedRollbackAndPreservedNewBytes: true,
      readySha256: sha256(await readFile(ready)),
      dirtySha256: sha256(await readFile(dirty)),
      utf16Sha256: sha256(await readFile(utf16)),
      conflictSha256: sha256(await readFile(conflict)),
    }, null, 2));
  } finally {
    if (app) await stop(app);
  }
});

test('real Release global activation defaults off, reports OS conflicts, restores focus, and releases registration', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  let app: Awaited<ReturnType<typeof launchOwned>> | undefined;
  let releaseConflict: (() => Promise<void>) | undefined;
  let releaseEnabledProbe: (() => Promise<void>) | undefined;
  try {
    app = await launchOwned(project, test.info(), 'M2 global shortcut');
    await app.page.getByRole('button', { name: '打开设置', exact: true }).click();
    const dialog = app.page.getByRole('dialog', { name: '设置', exact: true });
    await expect(dialog.locator('#setting-label-globalLaunchEnabled')).not.toBeChecked();
    await expect(dialog.locator('#setting-label-globalLaunchShortcut')).toHaveValue('Ctrl+Shift+Space');

    await dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
    releaseConflict = await holdShortcut('Ctrl+Shift+F12');
    const conflict = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('set_global_shortcut', { enabled: true, shortcut: 'Ctrl+Shift+F12' });
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const enabled = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('set_global_shortcut', { enabled: true, shortcut: 'Ctrl+Shift+F10' });
    });
    expect(enabled).toEqual({ ok: true, value: { enabled: true } });

    const failedReplacement = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('set_global_shortcut', { enabled: true, shortcut: 'Ctrl+Shift+F12' });
    });
    expect(failedReplacement).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const owned = ['-ProcessId', String(app.child.pid), '-ExpectedExecutable', app.executable];
    await runHelper(['-Action', 'Minimize', ...owned]);
    await expect.poll(async () => JSON.parse(await runHelper(['-Action', 'Query', ...owned])).minimized)
      .toBe(true);
    await runHelper(['-Action', 'Press', '-Shortcut', 'Ctrl+Shift+F10']);
    await expect.poll(async () => JSON.parse(await runHelper(['-Action', 'Query', ...owned])), { timeout: 10_000 })
      .toMatchObject({ minimized: false, foreground: true });
    await app.page.screenshot({ path: path.join(app.evidence, 'global-shortcut-restored-focus.png') });
    await releaseConflict();
    releaseConflict = undefined;

    const switched = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('set_global_shortcut', { enabled: true, shortcut: 'Ctrl+Shift+F11' });
    });
    expect(switched).toEqual({ ok: true, value: { enabled: true } });

    await runHelper(['-Action', 'Minimize', ...owned]);
    await expect.poll(async () => JSON.parse(await runHelper(['-Action', 'Query', ...owned])).minimized)
      .toBe(true);
    await runHelper(['-Action', 'Press', '-Shortcut', 'Ctrl+Shift+F11']);
    await expect.poll(async () => JSON.parse(await runHelper(['-Action', 'Query', ...owned])), { timeout: 10_000 })
      .toMatchObject({ minimized: false, foreground: true });

    const disabled = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      return native.invoke('set_global_shortcut', { enabled: false, shortcut: 'Ctrl+Shift+F11' });
    });
    expect(disabled).toEqual({ ok: true, value: { enabled: false } });

    releaseEnabledProbe = await holdShortcut('Ctrl+Shift+F11');
    await writeFile(path.join(app.evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: app.executable,
      executableBytes: app.executableBytes,
      executableSha256: app.executableSha256,
      dataDir: app.dataDir,
      scope: 'Real Release, WebView2 settings UI, Windows RegisterHotKey/keyboard input and actual foreground-window state',
      defaultDisabled: true,
      externalRegistrationConflictVisible: true,
      enableSucceededAfterConflictCleared: true,
      failedReplacementPreservedExistingRegistration: true,
      minimizedWindowRestoredAndFocusedByHotkey: true,
      disablingReleasedRegistrationAllowingExternalReservation: true,
    }, null, 2));
  } finally {
    if (releaseEnabledProbe) await releaseEnabledProbe();
    if (releaseConflict) await releaseConflict();
    if (app) await stop(app);
  }
});

test('real Release privacy cleanup protects active drafts, preserves failures, and separates recent/favorites storage', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  let app: Awaited<ReturnType<typeof launchOwned>> | undefined;
  try {
    app = await launchOwned(project, test.info(), 'M2 privacy cleanup');
    const folder = path.join(app.dataDir, 'M2 privacy workspace');
    await mkdir(folder);
    const source = path.join(folder, 'active.txt');
    const privateBody = 'active private draft 9cce7c7f';
    const privateSearch = 'search private 2d190e49';
    await writeFile(source, 'original\n', 'utf8');
    await app.page.locator('button[aria-keyshortcuts="Control+Shift+E"]').click();
    await app.chooser.select('open-folder', folder);
    await app.page.locator('[data-workspace-tree]')
      .getByRole('treeitem', { name: 'active.txt', exact: true }).click();
    await expect(editor(app.page)).toHaveText('original\n');
    await editor(app.page).focus();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.insertText(privateBody);
    await app.page.keyboard.press('Control+f');
    await app.page.locator('.find-bar').getByRole('textbox', { name: '查找内容', exact: true }).fill(privateSearch);
    await app.page.locator('.find-bar').getByRole('button', { name: '关闭查找', exact: true }).click();
    const tabId = await app.page.getByRole('tab', { selected: true }).getAttribute('id');
    if (!tabId?.startsWith('tab-')) throw new Error('Active document id missing');
    const activeDocumentId = tabId.slice(4);
    const inactiveDocumentId = randomUUID();
    const receipts = await app.page.evaluate(async ids => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<{
          ok: boolean;
          value?: { receiptId: string };
          error?: { message: string };
        }>;
      };
      const write = (documentId: string, text: string) => native.invoke('write_recovery_snapshot', {
        documentId, documentVersion: 1, reason: 'periodic', baseDiskRevision: null, text,
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, newlineMap: null,
      });
      const active = await write(ids.activeDocumentId, 'protected active recovery body');
      const inactive = await write(ids.inactiveDocumentId, 'cleanable inactive recovery body');
      if (!active.ok || !inactive.ok || !active.value || !inactive.value) {
        throw new Error(active.error?.message ?? inactive.error?.message ?? 'Recovery snapshot failed');
      }
      return { active: active.value.receiptId, inactive: inactive.value.receiptId };
    }, { activeDocumentId, inactiveDocumentId });
    const damagedId = randomUUID();
    const damaged = path.join(app.state, 'recovery', damagedId);
    await mkdir(damaged);
    await writeFile(path.join(damaged, 'body.bin'), 'damaged retained bytes', 'utf8');
    await writeFile(path.join(damaged, 'manifest.json'), '{damaged recovery manifest', 'utf8');

    const recent = app.page.locator('section[aria-labelledby="recent-heading"]');
    const favorites = app.page.locator('section[aria-labelledby="favorites-heading"]');
    await expect.poll(() => recent.locator('[data-recent-kind]').count()).toBeGreaterThan(0);
    await favorites.getByRole('button', { name: '收藏当前文件', exact: true }).click();
    await favorites.getByRole('button', { name: '收藏当前根', exact: true }).click();
    await expect(favorites.locator('.recent-list > li')).toHaveCount(2);
    const recoveryDirectoryBody = await readFile(path.join(app.state, 'recovery', receipts.active, 'body.bin'), 'utf8');
    expect(recoveryDirectoryBody).toBe('protected active recovery body');

    await recent.getByRole('button', { name: '清空', exact: true }).click();
    await recent.getByRole('button', { name: '确认清空最近记录', exact: true }).click();
    await expect(recent.locator('[data-recent-kind]')).toHaveCount(0);
    await favorites.getByRole('button', { name: '清空', exact: true }).click();
    await favorites.getByRole('button', { name: '确认清空收藏', exact: true }).click();
    await expect(favorites.locator('.recent-list > li')).toHaveCount(0);
    expect(await readFile(path.join(app.state, 'recovery', receipts.active, 'body.bin'), 'utf8'))
      .toBe('protected active recovery body');
    expect(await readFile(path.join(app.state, 'recovery', receipts.inactive, 'body.bin'), 'utf8'))
      .toBe('cleanable inactive recovery body');
    expect(await readFile(path.join(damaged, 'manifest.json'), 'utf8')).toBe('{damaged recovery manifest');

    const recoveryPanel = app.page.locator('.recovery-panel');
    await app.page.getByRole('button', { name: '显示本地恢复', exact: true }).click();
    await recoveryPanel.getByRole('button', { name: '重新扫描本地记录', exact: true }).click();
    await expect(recoveryPanel).toContainText('2 个恢复副本');
    await expect(recoveryPanel).toContainText('active.txt');
    await expect(recoveryPanel).toContainText('默认保护');
    await expect(recoveryPanel).toContainText('保留的异常记录（1）');
    await recoveryPanel.getByRole('button', { name: '清理非活动恢复记录…', exact: true }).click();
    const confirmation = recoveryPanel.getByRole('group', { name: '确认清理非活动恢复记录', exact: true });
    await expect(confirmation).toContainText('活动未保存副本和无法识别的记录会保留');
    await confirmation.getByRole('button', { name: /确认清理 1 个非活动文档/ }).click();
    await expect(recoveryPanel.getByRole('status'))
      .toContainText('已清理 1 个非活动恢复条目；活动未保存副本未改动');
    await expect(recoveryPanel).toContainText('恢复记录 1 个');
    expect(await readFile(path.join(app.state, 'recovery', receipts.active, 'body.bin'), 'utf8'))
      .toBe('protected active recovery body');
    await expect(stat(path.join(app.state, 'recovery', receipts.inactive))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(damaged, 'manifest.json'), 'utf8')).toBe('{damaged recovery manifest');

    const storedSettings = await readFile(path.join(app.state, 'settings/settings.json'), 'utf8');
    expect(storedSettings).not.toContain(privateBody);
    expect(storedSettings).not.toContain(privateSearch);
    expect(storedSettings.toLowerCase()).not.toContain('telemetry');
    await app.page.screenshot({ path: path.join(app.evidence, 'privacy-cleanup-protected.png') });
    await writeFile(path.join(app.evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable: app.executable,
      executableBytes: app.executableBytes,
      executableSha256: app.executableSha256,
      dataDir: app.dataDir,
      scope: 'Real Release/WebView2 settings and recovery storage with actual files; Playwright drives UI',
      activeDirtyRecoveryProtected: true,
      inactiveRecoveryRemovedAfterConfirmation: true,
      damagedRecoveryRetained: true,
      recentAndFavoritesClearedIndependently: true,
      recoveryBodySurvivedUnrelatedClears: true,
      storedSettingsContainNoDocumentBodySearchOrTelemetry: true,
      activeReceipt: receipts.active,
      inactiveReceipt: receipts.inactive,
      damagedReceipt: damagedId,
    }, null, 2));
  } finally {
    if (app) await stop(app);
  }
});

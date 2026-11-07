import { menuItem } from '../ui-actions';
import { chromium, expect, test, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { NativeChooser } from './scenarios';
import { evidenceRunId } from '../../test-evidence';
import type { SessionManifest } from '../../src/shared/contracts/files';

const runFile = promisify(execFile);
const editor = (page: Page) => page.locator('.cm-content');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release hot exit flushes dirty buffers, restores sources, and fences failed discard', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  const exe = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(exe));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'recovery');
  await mkdir(evidence, { recursive: true });
  const chooserRoot = path.join(project, '.artifacts/T002');
  await mkdir(chooserRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(chooserRoot, 'webview2-recovery-'));
  const state = path.join(dataDir, 'featherpad-state');
  const instances: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> }[] = [];

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
    const profile = await mkdtemp(path.join(dataDir, 'profile-'));
    const child = spawn(exe, [], { cwd: project, windowsHide: true, stdio: 'ignore', env: {
      ...process.env, FEATHERPAD_USER_DATA_DIR: state, WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    } });
    let launchError: Error | null = null;
    child.once('error', error => { launchError = error; });
    await expect.poll(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    instances.push({ child, browser });
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    const chooser = new NativeChooser({ page, child, dataDir, executable: exe,
      executableSha256, evidence, cleanupTasks: [] });
    return { page, child, browser, chooser };
  }
  async function requestClose(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) throw new Error('Owned native process missing');
    const exeLiteral = `'${exe.replaceAll("'", "''")}'`;
    const result = await runFile('powershell.exe', ['-NoProfile', '-Command',
      `$taskProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; if ($taskProcess.Path -ne ${exeLiteral}) { throw 'Owned executable mismatch' }; if (-not $taskProcess.CloseMainWindow()) { throw 'WM_CLOSE was not sent' }`],
    { windowsHide: true, timeout: 10_000 });
    expect(result.stderr).toBe('');
  }
  async function waitClosed(child: ChildProcess) {
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
  }
  async function append(page: Page, text: string) {
    await editor(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(text);
  }
  async function moveOwned(from: string, to: string) {
    for (const item of [from, to]) {
      if (!path.isAbsolute(item) || !path.resolve(item).startsWith(`${path.resolve(dataDir)}${path.sep}`)) {
        throw new Error('Move must remain inside the owned fixture');
      }
    }
    await rename(from, to);
  }

  try {
    const folder = path.join(dataDir, '中文恢复工作区😀');
    await mkdir(folder);
    const source = path.join(folder, 'named.txt');
    const second = path.join(folder, 'second.txt');
    const clean = path.join(folder, 'clean.txt');
    await writeFile(source, '命名原文😀', 'utf8');
    await writeFile(second, '第二份原文😀', 'utf8');
    await writeFile(clean, '干净预览😀', 'utf8');
    let app = await launch();
    await expect(app.page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    await app.page.getByRole('button', { name: '打开文件', exact: true }).click();
    await app.chooser.select('open', source);
    await expect(editor(app.page)).toHaveText('命名原文😀');
    await append(app.page, ' 已保存');
    await app.page.keyboard.press('Control+s');
    await expect(app.page.getByRole('status')).toContainText('未修改');
    const diskHash = sha(await readFile(source));
    await append(app.page, ' 最新命名草稿');
    await (await menuItem(app.page, '打开文件夹')).click();
    await app.chooser.select('open-folder', folder);
    await app.page.getByRole('treeitem', { name: 'second.txt', exact: true }).click();
    await expect(editor(app.page)).toHaveText('第二份原文😀');
    await append(app.page, ' 第二份草稿');
    await app.page.getByRole('treeitem', { name: 'clean.txt', exact: true }).click();
    await expect(editor(app.page)).toHaveText('干净预览😀');
    await app.page.keyboard.press('Control+n');
    const draft = Array.from({ length: 100 }, (_, index) => `未命名😀 ${index}`).join('\n');
    await append(app.page, draft);
    // This last input is immediately followed by real WM_CLOSE, before its debounce can be relied on.
    await append(app.page, ' 最后输入');
    const expectedDraft = `${draft} 最后输入`;
    await requestClose(app.child);
    await waitClosed(app.child);
    const manifestPath = path.join(state, 'session/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SessionManifest;
    expect(manifest.windows[0]?.views).toHaveLength(4);
    expect(manifest.windows[0]?.views.filter(view => view.dirty)).toHaveLength(3);
    expect(manifest.windows[0]?.views.find(view => view.title === 'clean.txt')?.isPreview).toBe(true);
    for (const view of manifest.windows[0]!.views.filter(view => view.dirty)) {
      expect(view.recoveryReceiptId).toBeTruthy();
      const directory = path.join(state, 'recovery', view.recoveryReceiptId!);
      const snapshot = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
        reason: string; bufferVersion: number; bodySha256: string;
      };
      expect(snapshot.reason).toBe('hot-exit');
      expect(snapshot.bufferVersion).toBe(view.bufferVersion);
      expect(sha(await readFile(path.join(directory, 'body.bin')))).toBe(snapshot.bodySha256);
    }
    expect(sha(await readFile(source))).toBe(diskHash);
    expect(await readFile(second, 'utf8')).toBe('第二份原文😀');
    const unnamed = manifest.windows[0]!.views.find(view => view.displayPath === null)!;
    expect(await readFile(path.join(state, 'recovery', unnamed.recoveryReceiptId!, 'body.bin'), 'utf8'))
      .toBe(expectedDraft);
    await writeFile(path.join(evidence, 'hot-exit-manifest.json'), JSON.stringify(manifest, null, 2));
    // Simulate reopening a window whose former monitor is unavailable.
    manifest.windows[0]!.bounds = { x: -99_999, y: 99_999, width: 4000, height: 3000 };
    await writeFile(manifestPath, JSON.stringify(manifest));
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(4);
    await expect(editor(app.page)).toContainText(' 最后输入');
    await expect(app.page.locator('.editor-metrics')).toContainText('行 100');
    await expect(app.page.getByRole('treeitem', { name: 'clean.txt', exact: true })).toBeVisible();
    const visibleBounds = await app.page.evaluate(async () => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<{
          scaleFactor: number; workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
        }[]>;
      };
      const monitors = await native.invoke('plugin:window|available_monitors', {});
      const actual = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
      const visible = monitors.some(monitor => {
        const scale = monitor.scaleFactor;
        const work = monitor.workArea;
        return actual.x >= work.position.x / scale && actual.y >= work.position.y / scale
          && actual.x + actual.width <= (work.position.x + work.size.width) / scale
          && actual.y + actual.height <= (work.position.y + work.size.height) / scale;
      });
      return { actual, visible };
    });
    expect(visibleBounds.visible).toBe(true);
    const tabIds = await app.page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.id.slice(4)));
    expect(tabIds).toEqual(manifest.windows[0]!.views.map(view => view.documentId));
    await app.page.getByRole('tab', { name: /named\.txt/ }).click();
    await expect(editor(app.page)).toHaveText('命名原文😀 已保存 最新命名草稿');
    expect(sha(await readFile(source))).toBe(diskHash);

    // A controlled non-directory at the session location makes session flush fail without filling a volume.
    const sessionDirectory = path.join(state, 'session');
    const preservedSession = path.join(state, `session-preserved-${randomUUID()}`);
    await moveOwned(sessionDirectory, preservedSession);
    await writeFile(sessionDirectory, 'controlled session-storage blocker');
    await requestClose(app.child);
    const dialog = app.page.getByRole('dialog', { name: '无法完成安全退出', exact: true });
    await expect(dialog).toBeVisible();
    expect(app.child.exitCode).toBeNull();
    await dialog.getByRole('button', { name: '放弃全部修改并退出', exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(app.child.exitCode).toBeNull();
    await moveOwned(sessionDirectory, path.join(state, `session-blocker-${randomUUID()}.fixture`));
    await moveOwned(preservedSession, sessionDirectory);
    await dialog.getByRole('button', { name: '返回编辑器', exact: true }).click();
    await expect(editor(app.page)).toHaveText('命名原文😀 已保存 最新命名草稿');
    await requestClose(app.child);
    await waitClosed(app.child);
    await writeFile(second, '受控外部变更😀', 'utf8');
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(4);
    await expect(editor(app.page)).toHaveText('命名原文😀 已保存 最新命名草稿');
    expect(sha(await readFile(source))).toBe(diskHash);
    await app.page.getByRole('tab', { name: /second\.txt/ }).click();
    await expect(editor(app.page)).toHaveText('第二份原文😀 第二份草稿');
    await expect(editor(app.page)).toHaveAttribute('contenteditable', 'false');
    await expect(app.page.locator('.document-view')).toContainText('磁盘内容在应用关闭期间发生变化');
    expect(await readFile(second, 'utf8')).toBe('受控外部变更😀');

    const fallbackId = randomUUID();
    const receipts = await app.page.evaluate(async id => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<{
          ok: boolean; value?: { receiptId: string }; error?: { code: string };
        }>;
      };
      const request = { documentId: id, reason: 'periodic',
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' } };
      const older = await native.invoke('write_recovery_snapshot', { ...request, documentVersion: 1, text: '保底版本😀' });
      const newer = await native.invoke('write_recovery_snapshot', { ...request, documentVersion: 2, text: '损坏前最新版本😀' });
      if (!older.ok || !newer.ok || !older.value || !newer.value) throw new Error('Native fallback snapshots failed');
      return { older: older.value.receiptId, newer: newer.value.receiptId };
    }, fallbackId);
    const damagedBody = path.join(state, 'recovery', receipts.newer, 'body.bin');
    await writeFile(damagedBody, '受控损坏证据，保留', 'utf8');

    const transactionId = randomUUID();
    const transactionDirectory = path.join(state, 'save-transactions', transactionId);
    await mkdir(transactionDirectory);
    const transactionSource = path.join(folder, 'transaction-source.txt');
    const original = Buffer.from('事务原件😀', 'utf8');
    const transactionBody = Buffer.from('事务待保存😀\r\n下一行', 'utf8');
    await writeFile(transactionSource, original);
    const transactionManifest = {
      schemaVersion: 1, receiptId: transactionId, requestId: randomUUID(), documentId: randomUUID(),
      documentVersion: 7, target: transactionSource,
      temporary: path.join(folder, `.featherpad-${transactionId}.tmp`),
      backup: path.join(folder, `.featherpad-${transactionId}.bak`), expectedRevision: 'a'.repeat(64),
      originalSha256: sha(original), bodySha256: sha(transactionBody),
      originalBytes: original.length, bodyBytes: transactionBody.length,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
    };
    await writeFile(path.join(transactionDirectory, 'manifest.json'), JSON.stringify(transactionManifest));
    await writeFile(path.join(transactionDirectory, 'body.bin'), transactionBody);
    await writeFile(path.join(transactionDirectory, 'original.bin'), original);
    await writeFile(path.join(transactionDirectory, 'staged.json'), JSON.stringify({ receiptId: transactionId, stage: 'staged' }));
    await app.page.reload();
    await expect(app.page.getByRole('tab')).toHaveCount(5);
    await app.page.locator(`#tab-${fallbackId}`).click();
    await expect(editor(app.page)).toHaveText('保底版本😀');
    expect(await readFile(damagedBody, 'utf8')).toBe('受控损坏证据，保留');
    const recoveryPanel = app.page.locator('.recovery-panel');
    await app.page.getByRole('button', { name: '显示本地恢复', exact: true }).click();
    await recoveryPanel.getByRole('button', { name: '打开恢复副本：transaction-source.txt', exact: true }).click();
    await expect(editor(app.page)).toHaveText('事务待保存😀下一行');
    await expect(recoveryPanel.getByRole('status')).toContainText('已打开');
    await expect(app.page.locator('.document-view')).toContainText('另存为新文件');
    expect(await readFile(transactionSource)).toEqual(original);
    expect(await readFile(path.join(transactionDirectory, 'body.bin'))).toEqual(transactionBody);
    await app.page.screenshot({ path: path.join(evidence, 'native-restored.png') });

    const finalSession = path.join(state, `session-before-discard-${randomUUID()}`);
    await moveOwned(sessionDirectory, finalSession);
    await writeFile(sessionDirectory, 'controlled session-storage blocker');
    await requestClose(app.child);
    const finalDialog = app.page.getByRole('dialog', { name: '无法完成安全退出', exact: true });
    await expect(finalDialog).toBeVisible();
    await moveOwned(sessionDirectory, path.join(state, `session-blocker-${randomUUID()}.fixture`));
    await moveOwned(finalSession, sessionDirectory);
    await finalDialog.getByRole('button', { name: '放弃全部修改并退出', exact: true }).click();
    await waitClosed(app.child);
    app = await launch();
    await expect(app.page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    await expect(app.page.getByRole('tab')).toHaveCount(0);
    expect(sha(await readFile(source))).toBe(diskHash);
    expect(await readFile(second, 'utf8')).toBe('受控外部变更😀');
    expect(await readFile(transactionSource)).toEqual(original);

    // T110's crash-specific check: only a verified, complete snapshot is guaranteed.
    await app.page.getByRole('button', { name: '新建文本', exact: true }).click();
    await append(app.page, '已完成周期快照😀');
    const crashTab = await app.page.getByRole('tab', { selected: true }).getAttribute('id');
    if (!crashTab?.startsWith('tab-')) throw new Error('Crash fixture document id missing');
    const crashDocumentId = crashTab.slice(4);
    async function completeCrashSnapshots() {
      const result: { version: number; createdAt: string; text: string }[] = [];
      for (const receipt of await readdir(path.join(state, 'recovery'))) {
        if (!/^[0-9a-f-]{36}$/.test(receipt)) continue;
        try {
          const directory = path.join(state, 'recovery', receipt);
          const record = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
            documentId: string; bufferVersion: number; bodySha256: string; bodyBytes: number; createdAt: string;
          };
          if (record.documentId !== crashDocumentId) continue;
          const bytes = await readFile(path.join(directory, 'body.bin'));
          if (bytes.length === record.bodyBytes && sha(bytes) === record.bodySha256) {
            result.push({ version: record.bufferVersion, createdAt: record.createdAt, text: bytes.toString('utf8') });
          }
        } catch (error) {
          if (!(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT')) throw error;
        }
      }
      return result.sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
    }
    await expect.poll(async () => (await completeCrashSnapshots())[0]?.text).toBe('已完成周期快照😀');
    await append(app.page, ' 尚未确认的最后输入');
    expect(app.child.kill()).toBe(true);
    await expect.poll(() => app.child.exitCode !== null || app.child.signalCode !== null).toBe(true);
    const terminated = { exitCode: app.child.exitCode, signalCode: app.child.signalCode };
    const latestComplete = (await completeCrashSnapshots())[0]!;
    app = await launch();
    await expect(app.page.locator(`#tab-${crashDocumentId}`)).toBeVisible();
    await expect(editor(app.page)).toHaveText(latestComplete.text);
    const saveAsSession = path.join(state, `session-before-save-as-${randomUUID()}`);
    await moveOwned(sessionDirectory, saveAsSession);
    await writeFile(sessionDirectory, 'controlled session-storage blocker');
    await requestClose(app.child);
    const saveAsDialog = app.page.getByRole('dialog', { name: '无法完成安全退出', exact: true });
    await expect(saveAsDialog).toBeVisible();
    await moveOwned(sessionDirectory, path.join(state, `session-blocker-${randomUUID()}.fixture`));
    await moveOwned(saveAsSession, sessionDirectory);
    const savedCopy = path.join(dataDir, '恢复故障后另存😀.txt');
    await saveAsDialog.getByRole('button', { name: '全部另存后退出', exact: true }).click();
    await app.chooser.select('save', savedCopy);
    await waitClosed(app.child);
    expect(await readFile(savedCopy, 'utf8')).toBe(latestComplete.text);
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(1);
    await expect(editor(app.page)).toHaveText(latestComplete.text);
    await expect(app.page.getByRole('status')).toContainText('未修改');
    expect(sha(await readFile(source))).toBe(diskHash);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable: exe, executableSha256, dataDir,
      namedAndUntitledHotExit: true, cleanAndWorkspaceRestored: true,
      latestSnapshotsVerified: true, failedSessionPreventsExit: true,
      missingMonitorBoundsRestoredIntoVisibleWorkArea: visibleBounds,
      failedDiscardRetainsContentAndReprotects: true, sourceSha256: diskHash,
      diskChangeReadOnlyPreservesBoth: true, damagedLatestFallsBack: true,
      saveTransactionCopyReadsWithoutWritingSource: true, explicitDiscardDoesNotRestoreBuffers: true,
      failedExitCanSaveAsAndRestartClean: true,
      crashRecoversLatestVerifiedSnapshot: { verified: true, durableVersion: latestComplete.version,
        recoveredSha256: sha(Buffer.from(latestComplete.text)), terminated,
        unacknowledgedLastInputGuaranteed: false },
      recoveryEntries: (await readdir(path.join(state, 'recovery'))).length,
    }, null, 2));
  } finally {
    for (const app of instances) {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

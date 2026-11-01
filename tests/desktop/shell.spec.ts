import { chromium, expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyNativeSaveAll } from './save-all';
import { verifyNativeOverwrite, type OverwriteAction } from './overwrite';
import { verifyNativeHardlinks, type HardlinkAction } from './hardlinks';
import { verifyNativeForcedExit } from './forced-exit';
import { verifyNativeDegradedEditing } from './degraded';
import { verifyNativeLargeFiles } from './large-files';
import { verifyNativeWorkspace } from './workspace';
import { verifyNativeEditor } from './editor';
import { verifyNativeSearch } from './search';

const runFile = promisify(execFile);

test('real Tauri WebView2 shell, without a mock bridge', async () => {
  const verifyChooser = process.env.FEATHERPAD_VERIFY_CHOOSER !== '0';
  const chooserAutomation = process.env.FEATHERPAD_CHOOSER_AUTOMATION ?? 'native-controls';
  if (chooserAutomation !== 'native-controls' && chooserAutomation !== 'manual') throw new Error('Invalid chooser automation mode');
  if (verifyChooser) test.setTimeout(240_000);
  const profile = process.env.FEATHERPAD_DESKTOP_PROFILE ?? 'release';
  if (profile !== 'release' && profile !== 'debug') throw new Error('Invalid desktop build profile');
  const root = process.cwd();
  const exe = path.join(root, 'src-tauri', 'target', profile, 'featherpad.exe');
  const hash = createHash('sha256').update(await readFile(exe)).digest('hex');
  const evidence = path.join(root, '.artifacts', 'T102');
  const workspaceEvidence = path.join(root, '.artifacts', 'T104');
  const editorEvidence = path.join(root, '.artifacts', 'T106');
  const searchEvidence = path.join(root, '.artifacts', 'T108');
  let nativeLargeFileObservation: Awaited<ReturnType<typeof verifyNativeLargeFiles>> | null = null;
  let nativeWorkspaceObservation: Awaited<ReturnType<typeof verifyNativeWorkspace>> | null = null;
  let nativeEditorObservation: Awaited<ReturnType<typeof verifyNativeEditor>>;
  let nativeSearchObservation: Awaited<ReturnType<typeof verifyNativeSearch>> | null = null;
  const chooserRoot = path.join(root, '.artifacts', 'T002');
  await mkdir(evidence, { recursive: true });
  await mkdir(workspaceEvidence, { recursive: true });
  await mkdir(editorEvidence, { recursive: true });
  await mkdir(searchEvidence, { recursive: true });
  await mkdir(chooserRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(chooserRoot, 'webview2-'));
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
      FEATHERPAD_USER_DATA_DIR: path.join(dataDir, 'featherpad-state'),
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
      const forgedSave = await native.invoke('save_document', {
        documentId: '00000000-0000-4000-8000-000000000000', requestId: crypto.randomUUID(), documentVersion: 1,
        expectedDiskRevision: '0'.repeat(64), text: 'controlled denied snapshot',
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
      });
      const malformedSave = await native.invoke('save_document', { documentId: null, unexpected: true });
      const unknownStat = await native.invoke('stat_document', { documentId: 'unknown-document' });
      const forgedDestination = await native.invoke('save_document_as', { documentId: crypto.randomUUID(), requestId: crypto.randomUUID(), documentVersion: 1,
        text: 'controlled denied path', format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, path: 'ungranted.txt' });
      let ungrantedPluginRejected = false;
      try { await native.invoke('plugin:fs|read_text_file', { path: 'ungranted-fixture.txt', options: {} }); }
      catch { ungrantedPluginRejected = true; }
      return { forged, malformed, forgedSave, malformedSave, unknownStat, forgedDestination, ungrantedPluginRejected };
    });
    expect(rejected.forged).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    expect(rejected.malformed).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(rejected.forgedSave).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(rejected.malformedSave).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(rejected.unknownStat).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(rejected.forgedDestination).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
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
      const second = path.join(dataDir, '第二份 emoji😀.txt');
      const marker = `FeatherPad ${randomUUID()}`;
      const secondMarker = `Independent ${randomUUID()}`;
      await writeFile(fixture, `原生选择器受控文件\r\n${marker}`, 'utf8');
      await writeFile(second, secondMarker, 'utf8');
      const fixtureRecords = await Promise.all([fixture, second].map(async file => ({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
      const manifest = path.join(chooserRoot, 'chooser-fixture.json');
      const selectionRecord = { fixtures: fixtureRecords, processId: child.pid, workerProcessId: process.pid,
        executable: exe, executableSha256: hash };
      await writeFile(manifest, JSON.stringify(selectionRecord));
      const helper = path.join(root, 'scripts', 'Select-ControlledFixture.ps1');
      if (chooserAutomation === 'native-controls') {
        const invalidManifest = path.join(chooserRoot, 'chooser-invalid-worker.json');
        await writeFile(invalidManifest, JSON.stringify({ ...selectionRecord, workerProcessId: 0 }));
        await expect(runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', invalidManifest], { windowsHide: true, timeout: 10_000 }))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Test process identity mismatch') });
      }
      await page.getByRole('button', { name: '打开文件', exact: true }).click();
      if (chooserAutomation === 'native-controls') {
        const result = await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
        await writeFile(path.join(evidence, `native-${profile}-chooser-controls.json`), result.stdout.trim());
      }
      await expect(page.getByRole('tab')).toHaveCount(2, { timeout: 90_000 });
      await page.getByRole('tab', { name: '中文 fixture.txt', exact: true }).click();
      await expect(page.locator('.cm-line')).toHaveText(['原生选择器受控文件', marker]);
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
      await page.screenshot({ path: path.join(evidence, `native-${profile}-file.png`) });
      await page.locator('.cm-content').focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' 中文😀未保存');
      await expect(page.getByRole('status')).toContainText('未保存修改');
      await page.getByRole('tab', { name: '第二份 emoji😀.txt', exact: true }).click();
      await expect(page.locator('.cm-content')).toHaveText(secondMarker);
      await page.getByRole('tab', { name: /中文 fixture.txt/ }).click();
      await expect(page.locator('.cm-content')).toContainText('中文😀未保存');
      await page.locator('.cm-content').focus();
      await page.keyboard.press('Control+z');
      await expect(page.locator('.cm-line')).toHaveText(['原生选择器受控文件', marker]);
      await expect(page.getByRole('status')).toContainText('未修改');
      await page.keyboard.press('Control+y');
      await expect(page.locator('.cm-content')).toContainText('中文😀未保存');
      if (chooserAutomation === 'native-controls') {
        await writeFile(manifest, JSON.stringify({ ...selectionRecord, fixtures: [fixtureRecords[0]] }));
        await page.getByRole('button', { name: '打开文件', exact: true }).click();
        await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
        await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeEnabled();
        await expect(page.getByRole('tab')).toHaveCount(2);
        await expect(page.locator('.cm-content')).toContainText('中文😀未保存');
      }
      await page.locator('.cm-content').focus();
      await page.keyboard.press('Control+s');
      await expect(page.getByRole('status')).toContainText('未修改');
      expect(await readFile(fixture, 'utf8')).toBe(`原生选择器受控文件\r\n${marker} 中文😀未保存`);
      const transactions = path.join(dataDir, 'featherpad-state', 'save-transactions');
      const { readdir } = await import('node:fs/promises');
      const receipts = await readdir(transactions);
      expect(receipts).toHaveLength(1);
      expect(await readFile(path.join(transactions, receipts[0]!, 'body.bin'), 'utf8')).toBe(await readFile(fixture, 'utf8'));
      await page.screenshot({ path: path.join(evidence, `native-${profile}-saved.png`) });
      // Keep the real native result intact, but delay its delivery to exercise late Ack handling.
      await page.evaluate(() => {
        const native = Reflect.get(window, '__TAURI_INTERNALS__') as { callbacks: Map<number, (data: unknown) => void> };
        const callbacks = native.callbacks;
        if (!(callbacks instanceof Map)) throw new Error('Framework debug callback table unavailable');
        const originalSet = callbacks.set;
        let used = false;
        callbacks.set = function (id, callback) {
          originalSet.call(this, id, data => {
            const value: unknown = data && typeof data === 'object' ? Reflect.get(data, 'value') : null;
            const isAck = data && typeof data === 'object' && Reflect.get(data, 'ok') === true
              && value && typeof value === 'object' && typeof Reflect.get(value, 'documentVersion') === 'number'
              && typeof Reflect.get(value, 'diskRevision') === 'string';
            if (isAck && !used) {
              used = true;
              callbacks.set = originalSet;
              Reflect.set(window, 'nativeSaveAckHeld', true);
              Reflect.set(window, 'releaseNativeSaveAck', () => callback(data));
            } else callback(data);
          });
          return this;
        };
      });
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' 回执前版本');
      await page.keyboard.press('Control+s');
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'nativeSaveAckHeld') === true)).toBe(true);
      await expect(page.getByRole('status')).toContainText('正在保存');
      const heldBytes = await readFile(fixture, 'utf8');
      expect(heldBytes).toContain('回执前版本');
      await page.keyboard.insertText(' 回执等待期间新输入');
      await page.evaluate(() => { const release = Reflect.get(window, 'releaseNativeSaveAck') as () => void; release(); });
      await expect(page.getByRole('status')).toContainText('未保存修改');
      await expect(page.locator('.cm-content')).toContainText('回执等待期间新输入');
      expect(await readFile(fixture, 'utf8')).toBe(heldBytes);
      await page.screenshot({ path: path.join(evidence, `native-${profile}-late-ack.png`) });
      await page.keyboard.press('Control+s');
      await expect(page.getByRole('status')).toContainText('未修改');
      expect(await readFile(fixture, 'utf8')).toBe(`${heldBytes} 回执等待期间新输入`);
      const external = `External native ${randomUUID()}`;
      await writeFile(fixture, external, 'utf8');
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' 冲突输入仍保留');
      await page.keyboard.press('Control+s');
      await expect(page.getByRole('alert')).toContainText('磁盘文件已变化');
      await expect(page.getByRole('status')).toContainText('未保存修改');
      await expect(page.locator('.cm-content')).toContainText('冲突输入仍保留');
      expect(await readFile(fixture, 'utf8')).toBe(external);
      await page.screenshot({ path: path.join(evidence, `native-${profile}-conflict.png`) });
      await page.keyboard.press('Control+n');
      await expect(page.getByRole('tab', { name: '无标题 1', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.insertText('原生中文😀草稿\n第二行');
      await expect(page.locator('.cm-line')).toHaveText(['原生中文😀草稿', '第二行']);
      if (chooserAutomation === 'native-controls') {
        async function chooseDestination(action: 'save' | 'cancel', destination?: string) {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action, fixtures: destination ? [{ path: destination }] : [] }));
          const result = await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
          await writeFile(path.join(evidence, `native-${profile}-${action}-controls.json`), result.stdout.trim());
        }
        async function openControlledFile(target: string) {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action: 'open',
            fixtures: [{ path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') }] }));
          await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], {
            windowsHide: true,
            timeout: 25_000,
          });
        }
        await page.keyboard.press('Control+s');
        await expect(page.getByRole('status')).toContainText('正在保存');
        await chooseDestination('cancel');
        await expect(page.getByRole('status')).toContainText('未保存修改');
        await expect(page.getByRole('tab', { name: /无标题 1/ })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.cm-line')).toHaveText(['原生中文😀草稿', '第二行']);
        await expect(page.getByRole('alert')).toHaveCount(0);
        const firstSave = path.join(dataDir, '首次 保存😀.txt');
        await page.keyboard.press('Control+s');
        await chooseDestination('save', firstSave);
        await expect(page.getByRole('status')).toContainText('未修改');
        await expect(page.getByRole('tab', { name: '首次 保存😀.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
        expect(await readFile(firstSave, 'utf8')).toBe('原生中文😀草稿\r\n第二行');
        await page.locator('.cm-content').focus();
        await page.keyboard.press('Control+End');
        await page.keyboard.insertText(' 副本输入');
        const copy = path.join(dataDir, '副本 保存😀.txt');
        await page.getByRole('button', { name: '保存副本', exact: true }).click();
        await chooseDestination('save', copy);
        await expect(page.getByText(`副本已保存：${copy}`, { exact: true })).toBeVisible();
        await expect(page.getByRole('status')).toContainText('未保存修改');
        await expect(page.getByRole('tab', { name: /首次 保存😀.txt/ })).toHaveAttribute('aria-selected', 'true');
        expect(await readFile(firstSave, 'utf8')).toBe('原生中文😀草稿\r\n第二行');
        expect(await readFile(copy, 'utf8')).toBe('原生中文😀草稿\r\n第二行 副本输入');
        await page.screenshot({ path: path.join(evidence, `native-${profile}-save-as-copy.png`) });
        await page.keyboard.press('Control+s');
        await expect(page.getByRole('status')).toContainText('未修改');
        expect(await readFile(firstSave, 'utf8')).toBe('原生中文😀草稿\r\n第二行 副本输入');
        expect(createHash('sha256').update(await readFile(second)).digest('hex')).toBe(fixtureRecords[1]?.sha256);
        await verifyNativeSaveAll(page, dataDir, second, firstSave, chooseDestination, evidence);
        let overwriteStep = 0;
        async function overwriteAction(action: OverwriteAction, destination: string) {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action,
            fixtures: [{ path: destination, sha256: createHash('sha256').update(await readFile(destination)).digest('hex') }] }));
          const result = await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
          await writeFile(path.join(evidence, `native-${profile}-overwrite-${++overwriteStep}-${action}.json`), result.stdout.trim());
        }
        await verifyNativeOverwrite(page, dataDir, second, overwriteAction, evidence);
        let hardlinkStep = 0;
        async function hardlinkAction(action: HardlinkAction, target: string) {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action,
            fixtures: [{ path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') }] }));
          const result = await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
          await writeFile(path.join(evidence, `native-${profile}-hardlink-${++hardlinkStep}-${action}.json`), result.stdout.trim());
        }
        await verifyNativeHardlinks(page, dataDir, hardlinkAction, evidence);
        await verifyNativeDegradedEditing(page, dataDir, async target => {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action: 'open-degraded',
            fixtures: [{ path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') }] }));
          await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 25_000 });
        }, evidence);
        nativeWorkspaceObservation = await verifyNativeWorkspace(page, dataDir, async target => {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action: 'open-folder',
            fixtures: [{ path: target }] }));
          await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], {
            windowsHide: true,
            timeout: 25_000,
          });
        }, workspaceEvidence);
        nativeLargeFileObservation = await verifyNativeLargeFiles(page, dataDir, async (target, action) => {
          await writeFile(manifest, JSON.stringify({ ...selectionRecord, action,
            fixtures: [{ path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') }] }));
          await runFile('powershell.exe', ['-NoProfile', '-File', helper, '-Manifest', manifest], { windowsHide: true, timeout: 45_000 });
        }, evidence, child.pid!);
        nativeSearchObservation = await verifyNativeSearch(page, dataDir, openControlledFile, searchEvidence);
      }
      if (chooserAutomation !== 'native-controls') {
        expect(createHash('sha256').update(await readFile(second)).digest('hex')).toBe(fixtureRecords[1]?.sha256);
      }
      expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).not.toBe(fixtureRecords[0]?.sha256);
      await page.screenshot({ path: path.join(evidence, `native-${profile}-documents.png`) });
    }
    nativeEditorObservation = await verifyNativeEditor(page, editorEvidence);
    const browserVersion = browser.version();
    const nativeUrl = page.url();
    const forcedExit = verifyChooser && chooserAutomation === 'native-controls'
      ? await verifyNativeForcedExit(page, child, dataDir) : null;
    await writeFile(path.join(evidence, `native-${profile}.json`), JSON.stringify({
      checkedAt: new Date().toISOString(),
      scope: 'Real Tauri/OS chooser/IPC/disk writes; test-only Ack delivery delay, no fake results/grants/IO; CDP composition input, no OS IME candidate window or Windows scaling coverage',
      executable: path.relative(root, exe), sha256: hash, pid: child.pid,
      profile, browserVersion, url: nativeUrl,
      nativeChooserVerified: verifyChooser,
      multiOpenAndDraftVerified: verifyChooser,
      nativeSaveVerified: verifyChooser,
      nativeConflictVerified: verifyChooser,
      nativeDelayedAckVerified: verifyChooser,
      nativeNewSaveAsAndCancelVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeCopyVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeSaveAllVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeExistingOverwriteVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeHardlinkConsentVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeForcedExitVerified: forcedExit !== null,
      nativeDegradedEditingVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeLargeChunkReadonlyVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeHeadPreviewVerified: verifyChooser && chooserAutomation === 'native-controls',
      nativeLargeFileObservation,
      nativeWorkspaceVerified: nativeWorkspaceObservation !== null,
      nativeWorkspaceObservation,
      nativeEditorVerified: nativeEditorObservation !== null,
      nativeEditorObservation,
      nativeSearchVerified: nativeSearchObservation !== null,
      nativeSearchObservation,
      forcedExit,
      chooserAutomation: verifyChooser ? chooserAutomation : 'disabled-explicitly',
      browserOffline: profile === 'release',
      checks: ['native-title', 'native-brand', 'tauri-ipc-present', 'light-theme', 'dark-theme', 'forged-grant-rejected', 'malformed-ref-rejected', 'forged-save-rejected', 'malformed-save-rejected', 'unknown-stat-rejected', 'ipc-destination-path-rejected', 'ungranted-plugin-rejected'],
    }, null, 2));
  } finally {
    try { if (browser?.isConnected()) await browser.close(); }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
});

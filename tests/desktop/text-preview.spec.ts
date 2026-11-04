import { menuItem } from '../ui-actions';
import { chromium, expect, test, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { NativeChooser } from './scenarios';
import { evidenceRunId } from '../../test-evidence';
import type { FileMetadata, ResultEnvelope, SessionManifest } from '../../src/shared/contracts/files';

const runFile = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release text previews preserve binary bytes, reject every write and recognize lossless UTF16', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native', evidenceRunId(test.info().config.metadata.evidenceRunId), 'text-preview');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-text-preview-'));
  const state = path.join(dataDir, 'featherpad-state');
  const root = path.join(dataDir, '只读试开 文件夹');
  await mkdir(root);
  const source = path.join(root, '试开😀.html');
  const bytes = Buffer.concat([Buffer.from([0x61, 0, 0xff]), Buffer.from('<script>window.previewExecuted=true</script>', 'utf8')]);
  await writeFile(source, bytes);
  const large = path.join(root, '大型二进制.bin');
  await writeFile(large, Buffer.alloc(20 * 1024 * 1024));
  const utf16 = path.join(root, '真实UTF16.txt');
  await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文😀正常UTF16', 'utf16le')]));
  const originals = await Promise.all([source, large, utf16].map(async file => ({ file, sha256: sha(await readFile(file)) })));
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
    const profile = await mkdtemp(path.join(dataDir, 'profile-'));
    const child = spawn(executable, [], { cwd: project, windowsHide: true, stdio: 'ignore', env: {
      ...process.env, FEATHERPAD_USER_DATA_DIR: state, WEBVIEW2_USER_DATA_FOLDER: profile,
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
    page.on('requestfailed', request => diagnostics.push({ type: 'requestfailed', origin: new URL(request.url()).origin, error: request.failure()?.errorText }));
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

  async function denyWrites(page: Page, documentId: string) {
    const metadata = await page.evaluate(async id => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: unknown) => Promise<unknown> };
      return native.invoke('stat_document', { documentId: id }) as Promise<ResultEnvelope<FileMetadata>>;
    }, documentId);
    if (!metadata.ok) throw new Error(`Native preview stat failed: ${metadata.error.code}`);
    for (const [command, intent] of [['save_document', null], ['overwrite_document', null],
      ['save_document_as', 'save-as'], ['save_document_as', 'copy']] as const) {
      const request = { documentId, requestId: crypto.randomUUID(), documentVersion: 0, text: 'forged writable text',
        format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
        ...(intent ? { intent } : { expectedDiskRevision: metadata.value.diskRevision }) };
      const result = await page.evaluate(async ({ command, request }) => {
        const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: unknown) => Promise<unknown> };
        return native.invoke(command, request);
      }, { command, request });
      expect(result, `${command}/${intent ?? 'save'}`).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    }
  }

  try {
    let app = await launch();
    await app.page.getByRole('button', { name: '打开文件', exact: true }).click();
    await app.chooser.select('open', source);
    await expect(app.page.getByRole('button', { name: '只读试开所选文件 1', exact: true })).toBeVisible();
    await expect(app.page.getByRole('tab')).toHaveCount(0);
    await app.page.getByRole('button', { name: '只读试开所选文件 1', exact: true }).click();
    const displayed = 'a␀�<script>window.previewExecuted=true</script>';
    await expect(app.page.locator('.cm-content')).toHaveText(displayed);
    await expect(app.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(app.page.getByText(/已完整显示文件的只读文本解释/)).toBeVisible();
    await app.page.locator('.cm-content').focus();
    await app.page.keyboard.type('cannot edit');
    await app.page.keyboard.press('Control+s');
    await expect(app.page.locator('.cm-content')).toHaveText(displayed);
    for (const name of ['保存', '另存为', '保存副本']) await expect(app.page.getByRole('button', { name, exact: true })).toBeDisabled();
    const id = (await app.page.getByRole('tab').getAttribute('id'))!.slice(4);
    await denyWrites(app.page, id);
    expect(await app.page.evaluate(() => Reflect.get(window, 'previewExecuted'))).toBeUndefined();
    await app.page.screenshot({ path: path.join(evidence, 'binary-readonly.png') });

    await (await menuItem(app.page, '打开文件夹')).click();
    await app.chooser.select('open-folder', root);
    await app.page.getByRole('treeitem', { name: '大型二进制.bin', exact: true }).click();
    await app.page.getByRole('button', { name: '只读试开所选文件 1', exact: true }).click();
    await expect(app.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(app.page.getByText('已试读 1,048,576 / 20,971,520 字节，内容已截断。', { exact: true })).toBeVisible();
    const largeId = (await app.page.getByRole('tab', { name: '大型二进制.bin', exact: true }).getAttribute('id'))!.slice(4);
    await denyWrites(app.page, largeId);
    await app.page.screenshot({ path: path.join(evidence, 'binary-bounded-preview.png') });

    await expect(app.page.getByRole('button', { name: '打开文件', exact: true })).toBeEnabled();
    await app.page.getByRole('treeitem', { name: '真实UTF16.txt', exact: true }).click();
    await expect(app.page.locator('.cm-content')).toHaveText('中文😀正常UTF16');
    await expect(app.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    await expect(app.page.getByRole('status')).toContainText('UTF-16LE');
    await expect(app.page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expect(app.page.getByRole('button', { name: '只读试开所选文件 1', exact: true })).toHaveCount(0);
    await closeNormally(app.child);
    const session = JSON.parse(await readFile(path.join(state, 'session/manifest.json'), 'utf8')) as SessionManifest;
    for (const documentId of [id, largeId]) expect(session.windows[0]?.views.find(view => view.documentId === documentId)?.openMode).toBe('text-preview');
    app = await launch();
    await expect(app.page.getByRole('tab')).toHaveCount(3);
    await app.page.locator(`[id="tab-${id}"]`).click();
    await expect(app.page.locator('.cm-content')).toHaveText(displayed);
    await expect(app.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await denyWrites(app.page, id);
    expect(await app.page.evaluate(() => Reflect.get(window, 'previewExecuted'))).toBeUndefined();
    for (const original of originals) expect(sha(await readFile(original.file))).toBe(original.sha256);
    await app.page.screenshot({ path: path.join(evidence, 'binary-restored-readonly.png') });
    await closeNormally(app.child);
    for (const instance of instances) expect(instance.diagnostics).toEqual([]);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable, executableSha256, browserVersion: app.browser.version(), dataDir,
      scope: 'Real offline Release, real native choosers and bytes; explicit text preview only; no business mocks',
      binaryRequiresExplicitChoice: true, malformedUtf8AndControlsVisibleWithoutExecution: true,
      saveOverwriteSaveAsAndCopyRejectedByNative: true, twentyMiBBinaryBoundedToOneMiB: true,
      bomUtf16NotMisclassified: true, sessionPersistsAndRestoresPreviewMode: true,
      sourceHashesUnchanged: originals, normalExitCode: app.child.exitCode,
    }, null, 2));
  } finally {
    for (const [index, app] of instances.entries()) {
      await writeFile(path.join(evidence, `ipc-diagnostics-${index}.json`), JSON.stringify(app.diagnostics));
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

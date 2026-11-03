import { chromium, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const FILE_COUNT = 10_000;
const FILE_BYTES = Math.ceil((100 * 1024 * 1024) / FILE_COUNT);

test('G2 Release searches a 10k-file 100MiB corpus and cancels a new scan', async () => {
  test.setTimeout(360_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableBytes = await readFile(executable);
  const executableSha256 = createHash('sha256').update(executableBytes).digest('hex');
  const executableBytesLength = (await stat(executable)).size;
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'g2-special');
  await mkdir(evidence, { recursive: true });
  const dataDir = await mkdtemp(path.join(project, '.artifacts/T002', 'webview2-g2-scale-'));
  const state = path.join(dataDir, 'featherpad-state');
  const corpus = path.join(dataDir, 'G2 scale workspace');
  await mkdir(corpus);
  for (let offset = 0; offset < FILE_COUNT; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, FILE_COUNT - offset) }, async (_, relative) => {
      const index = offset + relative;
      const marker = index === FILE_COUNT - 1 ? ' G2-FOUND-ONCE ' : ' G2-CANCEL-EACH ';
      const prefix = Buffer.from(marker, 'utf8');
      await writeFile(path.join(corpus, `item-${String(index).padStart(5, '0')}.txt`),
        Buffer.concat([prefix, Buffer.alloc(FILE_BYTES - prefix.length, 'x')]));
    }));
  }
  const corpusBytes = (await Promise.all(Array.from({ length: FILE_COUNT }, async (_, index) =>
    (await stat(path.join(corpus, `item-${String(index).padStart(5, '0')}.txt`))).size)))
    .reduce((sum, size) => sum + size, 0);
  expect(corpusBytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);

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
  const child = (await import('node:child_process')).spawn(executable, [], {
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
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        return false;
      }
    }, { timeout: 15_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    const browserVersion = browser.version();
    const chooser = new NativeChooser({
      page,
      child,
      dataDir,
      executable,
      executableSha256,
      evidence,
      cleanupTasks: [],
    });
    await page.locator('button[aria-keyshortcuts="Control+Shift+E"]').click();
    await chooser.select('open-folder', corpus);
    await expect(page.locator('[data-workspace-tree]').getByRole('treeitem', { name: 'item-00000.txt' }))
      .toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Control+Shift+F');
    const panel = page.locator('.workspace-search-panel');
    const query = panel.getByLabel('搜索内容', { exact: true });
    await query.fill('G2-FOUND-ONCE');
    await panel.getByLabel('区分大小写', { exact: true }).check();
    const fullStarted = Date.now();
    await panel.getByRole('button', { name: '开始搜索', exact: true }).click();
    await expect(panel).toContainText('10,000 个文件', { timeout: 120_000 });
    await expect(panel).toContainText('1 个匹配', { timeout: 120_000 });
    const fullElapsedMs = Date.now() - fullStarted;

    await query.fill('G2-CANCEL-EACH');
    await panel.getByRole('button', { name: '开始搜索', exact: true }).click();
    const cancel = panel.getByRole('button', { name: '取消搜索', exact: true });
    await expect(cancel).toBeVisible();
    const cancelStarted = Date.now();
    await cancel.click();
    await expect(panel).toContainText('已取消，结果不完整', { timeout: 120_000 });
    const cancelElapsedMs = Date.now() - cancelStarted;
    await page.screenshot({ path: path.join(evidence, 'g2-search-cancelled.png') });

    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable,
      executableBytes: executableBytesLength,
      executableSha256,
      browserVersion,
      dataDir,
      corpus,
      scope: 'Real Release/WebView2, native folder chooser and filesystem; Playwright drives the real workspace search UI',
      fileCount: FILE_COUNT,
      corpusBytes,
      fullScanElapsedMs: fullElapsedMs,
      cancellationElapsedMs: cancelElapsedMs,
      fullScanReportedAllFilesAndOneMatch: true,
      cancellationReportedIncomplete: true,
    }, null, 2));
  } finally {
    if (browser?.isConnected()) await browser.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
});

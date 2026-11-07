import { chromium, expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real Release persists, restores and recovers protected settings', async () => {
  test.setTimeout(180_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha256(await readFile(executable));
  const evidenceDirectory = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'settings');
  await mkdir(evidenceDirectory, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-settings-'));
  const stateDir = path.join(dataDir, 'featherpad-state');
  const settingsFile = path.join(stateDir, 'settings/settings.json');
  const instances: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> }[] = [];

  function ownedFixture(target: string) {
    if (!path.isAbsolute(target) || !path.resolve(target).startsWith(`${path.resolve(dataDir)}${path.sep}`)) {
      throw new Error('Settings fixture path escaped its controlled directory');
    }
    return target;
  }

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
    const child = spawn(executable, [], {
      cwd: project,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FEATHERPAD_USER_DATA_DIR: stateDir,
        WEBVIEW2_USER_DATA_FOLDER: profile,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      },
    });
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
    return { page, child, browser };
  }

  async function openSettings(page: Page) {
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('searchbox', { name: '搜索设置', exact: true })).toBeFocused();
    const save = dialog.getByRole('button', { name: '保存设置', exact: true });
    await expect(save).toBeEnabled();
    return { dialog, save };
  }

  async function stop(app: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> }) {
    if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
    await expect.poll(() => app.child.exitCode !== null || app.child.signalCode !== null).toBe(true);
  }

  try {
    let app = await launch();
    await expect(app.page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    await app.page.emulateMedia({ colorScheme: 'dark' });
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await app.page.keyboard.press('Control+n');
    const editor = app.page.locator('.document-view .cm-content');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveClass(/cm-lineWrapping/);
    await expect(app.page.locator('.document-view .cm-lineNumbers')).toHaveCount(1);

    let opened = await openSettings(app.page);
    await opened.dialog.getByRole('combobox', { name: '主题', exact: true }).click();
    await opened.dialog.getByRole('option', { name: '浅色', exact: true }).click();
    await opened.dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
    await opened.dialog.getByRole('checkbox', { name: '自动换行', exact: true }).uncheck();
    await opened.dialog.getByRole('checkbox', { name: '显示行号', exact: true }).uncheck();
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(app.page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '20px');
    await expect(editor).not.toHaveClass(/cm-lineWrapping/);
    await expect(app.page.locator('.document-view .cm-lineNumbers')).toHaveCount(0);
    await opened.dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
    await expect(opened.dialog).not.toBeVisible();
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(app.page.locator('.document-view .cm-scroller')).toHaveCSS('font-size', '14px');
    await expect(editor).toHaveClass(/cm-lineWrapping/);
    await expect(app.page.locator('.document-view .cm-lineNumbers')).toHaveCount(1);

    opened = await openSettings(app.page);
    await opened.dialog.getByLabel('导入设置文件', { exact: true }).setInputFiles({
      name: 'settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, settings: {
        theme: 'light', fontSize: 18, lineHeight: 1.7, wordWrap: false, lineNumbers: false,
        highlightActiveLine: false, futureNative: { retained: true },
      } })),
    });
    const importPreview = opened.dialog.getByRole('region', { name: '导入设置预览', exact: true });
    await expect(importPreview).toContainText('futureNative');
    expect(await readFile(settingsFile, 'utf8').catch(() => null)).toBeNull();
    await importPreview.getByRole('button', { name: '应用导入预览', exact: true }).click();
    await opened.dialog.getByRole('combobox', { name: '编辑器字体', exact: true }).fill('Consolas');
    await expect(opened.dialog.getByRole('note')).toHaveCount(0);
    await opened.save.click();
    await expect(opened.dialog.getByRole('status')).toContainText('设置已保存');
    const firstBytes = await readFile(settingsFile);
    const first = JSON.parse(firstBytes.toString('utf8')) as {
      schemaVersion: number; version: number; settings: Record<string, unknown>;
    };
    expect(first).toMatchObject({ schemaVersion: 1, version: 1, settings: {
      theme: 'light', fontFamily: 'Consolas', fontSize: 18, lineHeight: 1.7,
      wordWrap: false, lineNumbers: false, futureNative: { retained: true },
    } });
    await opened.dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
    await opened.save.click();
    await expect(opened.dialog.getByRole('status')).toContainText('设置已保存');
    const secondBytes = await readFile(settingsFile);
    const second = JSON.parse(secondBytes.toString('utf8')) as { version: number; settings: Record<string, unknown> };
    expect(second.version).toBe(2);
    expect(second.settings.fontSize).toBe(20);
    expect(second.settings.futureNative).toEqual({ retained: true });
    const backups = (await readdir(path.join(stateDir, 'settings')))
      .filter(name => /^settings-[0-9a-f-]{36}\.bak$/.test(name));
    expect(backups).toHaveLength(0);
    await app.page.screenshot({ path: path.join(evidenceDirectory, 'settings-saved.png') });
    await stop(app);

    app = await launch();
    await app.page.emulateMedia({ colorScheme: 'dark' });
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'light');
    opened = await openSettings(app.page);
    await expect(opened.dialog.getByRole('combobox', { name: '编辑器字体', exact: true })).toHaveValue('Consolas');
    await expect(opened.dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('20');
    await expect(opened.dialog.getByRole('checkbox', { name: '自动换行', exact: true })).not.toBeChecked();
    await expect(opened.dialog.getByRole('checkbox', { name: '显示行号', exact: true })).not.toBeChecked();
    await opened.dialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
    await app.page.keyboard.press('Control+n');
    const restoredEditor = app.page.locator('.document-view .cm-content');
    await expect(restoredEditor).not.toHaveClass(/cm-lineWrapping/);
    await expect(app.page.locator('.document-view .cm-lineNumbers')).toHaveCount(0);
    await app.page.screenshot({ path: path.join(evidenceDirectory, 'settings-restarted.png') });
    await stop(app);

    ownedFixture(settingsFile);
    const corruptBytes = Buffer.from('{broken settings fixture', 'utf8');
    await writeFile(settingsFile, corruptBytes);
    app = await launch();
    opened = await openSettings(app.page);
    await expect(opened.dialog.getByText(/设置文件损坏，已隔离并保留原件/)).toBeVisible();
    await expect(opened.dialog.getByRole('combobox', { name: '设置旧副本', exact: true })).toHaveCount(0);
    const settingEntries = await readdir(path.join(stateDir, 'settings'));
    const corruptName = settingEntries.find(name => name.startsWith('settings.corrupt-'));
    expect(corruptName).toBeTruthy();
    expect(await readFile(path.join(stateDir, 'settings', corruptName!))).toEqual(corruptBytes);
    await opened.dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('21');
    await opened.save.click();
    await expect(opened.dialog.getByRole('status')).toContainText('设置已保存');
    const fresh = JSON.parse(await readFile(settingsFile, 'utf8')) as { version: number; settings: Record<string, unknown> };
    expect(fresh).toMatchObject({ version: 1, settings: { fontSize: 21 } });
    const freshEntries = await readdir(path.join(stateDir, 'settings'));
    expect(freshEntries.some(name => name.endsWith('.bak') || name.endsWith('.tmp'))).toBe(false);
    await app.page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expect(opened.dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
    await app.page.screenshot({ path: path.join(evidenceDirectory, 'settings-corrupt-isolated-200.png') });
    await writeFile(path.join(evidenceDirectory, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable,
      executableSha256,
      dataDir,
      scope: 'Real Tauri/WebView2 settings storage and UI; no mock bridge',
      previewCancelRestoresEffectiveThemeFontAndCodeMirrorView: true,
      persistedUnknownSettingsAndNativeFontInventory: true,
      settingsBackupsRemovedAfterSave: true,
      firstSettingsSha256: sha256(firstBytes),
      secondSettingsSha256: sha256(secondBytes),
      restartRestoresThemeFontWrapLineNumbers: true,
      corruptOriginalIsolatedWithoutOverwrite: true,
      freshSettingsWrittenAfterCorruptIsolation: true,
      domZoom200SaveActionInViewport: true,
    }, null, 2));
    await stop(app);
  } finally {
    for (const app of instances) {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

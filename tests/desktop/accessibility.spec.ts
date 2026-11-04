import { chromium, expect, test, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { evidenceRunId } from '../../test-evidence';

const runFile = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Profile { version: number; settings: Record<string, unknown> }

test('real Release preserves editing through keyboard navigation and persists font zoom across hot exit', async () => {
  test.setTimeout(120_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableSha256 = sha256(await readFile(executable));
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'accessibility');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-accessibility-'));
  const state = path.join(dataDir, 'featherpad-state');
  const settingsFile = path.join(state, 'settings/settings.json');
  const instances: { child: ChildProcess; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> }[] = [];
  const errors: string[] = [];

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
      if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    instances.push({ child, browser });
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    return { page, child, browser };
  }

  async function resize(page: Page, width: number, height: number) {
    await page.evaluate(async size => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      await native.invoke('plugin:window|set_size', { label: 'main', value: { Logical: size } });
    }, { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  }

  async function closeNormally(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) throw new Error('Owned native process missing');
    const exeLiteral = `'${executable.replaceAll("'", "''")}'`;
    await runFile('powershell.exe', ['-NoProfile', '-Command',
      `$taskProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; if ($taskProcess.Path -ne ${exeLiteral}) { throw 'Owned executable mismatch' }; if (-not $taskProcess.CloseMainWindow()) { throw 'WM_CLOSE was not sent' }`],
    { windowsHide: true, timeout: 10_000 });
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
  }

  const stored = async (): Promise<Profile | null> => {
    try { return JSON.parse(await readFile(settingsFile, 'utf8')) as Profile; } catch { return null; }
  };

  try {
    let app = await launch();
    let page = app.page;
    await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
    await resize(page, 1200, 800);
    await page.keyboard.press('Control+n');
    let editor = page.getByRole('textbox', { name: '文档内容', exact: true });
    const text = '原生键盘😀\n  第二行';
    await editor.focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Tab');
    await expect(page.locator('.cm-line')).toHaveText(['    原生键盘😀', '      第二行']);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-line')).toHaveText(['原生键盘😀', '  第二行']);
    const selection = await page.evaluate(() => window.getSelection()?.toString());
    const toggle = page.getByRole('button', { name: 'Tab 移动焦点', exact: true });
    await page.keyboard.press('Control+m');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(editor).toBeFocused();
    await page.keyboard.press('Control+m');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await editor.focus();
    await page.keyboard.press('Control+a');
    const status = page.getByRole('status', { name: '应用状态', exact: true });
    await page.keyboard.press('F6');
    await expect(status).toBeFocused();
    await expect(status).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Shift+F6');
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);

    const tab = page.getByRole('tab', { name: /无标题 1/ });
    await expect(tab).toHaveAttribute('aria-description', '固定标签；有未保存修改');
    await expect(page.getByRole('button', { name: '关闭 无标题 1，有未保存修改', exact: true })).toBeVisible();
    const session = await page.context().newCDPSession(page);
    const tree = await session.send('Accessibility.getFullAXTree');
    const stateNode = tree.nodes.find(node => node.role?.value === 'status' && node.name?.value === '应用状态');
    expect(stateNode?.properties?.find(property => property.name === 'live')?.value.value).toBe('polite');
    expect(stateNode?.properties?.find(property => property.name === 'atomic')?.value.value).toBe(false);
    expect(tree.nodes.some(node => node.role?.value === 'group' && node.name?.value === '光标与字数')).toBe(true);
    await session.detach();
    await expect(page.getByRole('group', { name: '光标与字数', exact: true })).toHaveAttribute('aria-live', 'off');

    const scaleBefore = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, zoom: document.documentElement.style.zoom }));
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+Shift+Equal');
    await page.keyboard.press('Control+-');
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-size', '15px');
    await editor.hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-size', '16px');
    await expect.poll(async () => (await stored())?.settings.fontSize).toBe(16);
    expect(await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, zoom: document.documentElement.style.zoom }))).toEqual(scaleBefore);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
    await page.screenshot({ path: path.join(evidence, 'keyboard-font-zoom.png') });

    const origin = page.getByRole('button', { name: '打开设置', exact: true });
    await origin.click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    const search = dialog.getByRole('searchbox', { name: '搜索设置', exact: true });
    await expect(search).toBeFocused();
    await page.keyboard.press('F6');
    await expect(search).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('tab', { name: '全部', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const appearance = dialog.getByRole('tab', { name: '外观', exact: true });
    await expect(appearance).toBeFocused();
    await expect(appearance).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('tabpanel', { name: '外观', exact: true })).toBeFocused();
    await dialog.getByRole('spinbutton', { name: '编辑字号', exact: true }).fill('20');
    await appearance.focus();
    await page.keyboard.press('End');
    await expect(dialog.getByRole('tab', { name: '系统', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(dialog.getByRole('spinbutton', { name: '编辑字号', exact: true })).toHaveValue('20');
    await page.keyboard.press('Escape');
    await expect(origin).toBeFocused();
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-size', '16px');

    await editor.focus();
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('');
    await expect(tab).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
    await page.keyboard.press('Control+y');
    await expect(page.locator('.cm-line')).toHaveText(['原生键盘😀', '  第二行']);

    await resize(page, 800, 600);
    const sidebarToggle = page.getByRole('button', { name: '切换资源管理器', exact: true });
    const sidebar = page.getByRole('complementary', { name: '资源管理器', exact: true });
    if (await sidebar.count()) await sidebarToggle.click();
    await sidebarToggle.click();
    await expect(page.locator('.recent-panel').getByRole('button', { name: '全部', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect(sidebarToggle).toBeFocused();
    await origin.click();
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(evidence, 'settings-native-compact.png') });
    await page.keyboard.press('Escape');

    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' 退出前最后输入');
    // No storage polling here: check the last font request across real WM_CLOSE.
    await page.keyboard.press('Control+=');
    await closeNormally(app.child);
    const persisted = await stored();
    expect(persisted?.settings.fontSize).toBe(17);
    app = await launch();
    page = app.page;
    editor = page.getByRole('textbox', { name: '文档内容', exact: true });
    await expect(editor).toContainText('退出前最后输入');
    await expect(page.locator('.cm-line')).toHaveText(['原生键盘😀', '  第二行 退出前最后输入']);
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-size', '17px');
    await expect(page.getByRole('tab', { name: /无标题 1/ })).toHaveAttribute('aria-description', '固定标签；有未保存修改');
    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await stored())?.settings.fontSize).toBe(14);
    await page.screenshot({ path: path.join(evidence, 'font-restored-hot-exit.png') });
    const baselineMedia = await page.evaluate(() => ({
      forcedColors: matchMedia('(forced-colors: active)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      devicePixelRatio,
    }));
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), executable, executableSha256,
      executableBytes: (await stat(executable)).size, browserVersion: app.browser.version(), dataDir,
      scope: 'Real offline Release Tauri/WebView2, real settings and hot exit; no business mocks or media/DPI emulation',
      tabIndentUndoAndEscapeRoute: true, tabFocusModeAndF6PreserveSelectionAndUndo: true,
      statusAXAndDirtyRiskNames: true, settingsRovingTabsPreviewCancelAndFocusReturn: true,
      nativeWindow800CompactSidebarAndSettings: true,
      keyboardAndRealCtrlWheelPersistOnlyFont: true, lastFontRequestBeforeRealWmClosePersists: true,
      restartRestoresFontAndLatestDraft: true, resetFontPersists14: true,
      finalSettingsSha256: sha256(await readFile(settingsFile)), finalSettings: await stored(), baselineMedia,
      windowsScreenReaderAndSystemPreferenceMatrix: 'pending; AX and unchanged baseline are supporting evidence only',
    }, null, 2));
    await closeNormally(app.child);
  } finally {
    for (const app of instances) {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

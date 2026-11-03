import { chromium, expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { evidenceRunId } from '../../test-evidence';
import { NativeChooser } from './scenarios';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface StoredRecentEntry {
  id: string;
  kind: 'file' | 'workspace';
  canonicalIdentity: string;
  ref: { grantId: string; relativePath: string };
  title: string;
  displayPath: string;
  lastOpenedAt: string;
}

interface StoredProfile {
  schemaVersion: number;
  version: number;
  revision: string | null;
  settings: {
    recentHistoryEnabled?: boolean;
    recentHistoryItems?: { schemaVersion: 1; entries: StoredRecentEntry[] };
  };
}

test('real Release persists recent files, repairs missing grants, and honors privacy controls', async () => {
  test.setTimeout(240_000);
  const project = process.cwd();
  const executable = path.join(project, 'src-tauri/target/release/featherpad.exe');
  const executableBytes = await readFile(executable);
  const executableSha256 = sha256(executableBytes);
  const executableStat = await stat(executable);
  const evidence = path.join(project, '.artifacts/native',
    evidenceRunId(test.info().config.metadata.evidenceRunId), 'recent');
  await mkdir(evidence, { recursive: true });
  const fixtureRoot = path.join(project, '.artifacts/T002');
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(fixtureRoot, 'webview2-recent-'));
  const state = path.join(dataDir, 'featherpad-state');
  const settingsFile = path.join(state, 'settings/settings.json');
  const grantsFile = path.join(state, 'session/grants.json');
  const instances: {
    child: ChildProcess;
    browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  }[] = [];
  let browserVersion: string | null = null;

  function ownedFixture(target: string) {
    const root = `${path.resolve(dataDir)}${path.sep}`;
    if (!path.isAbsolute(target) || !path.resolve(target).startsWith(root)) {
      throw new Error('Recent-history fixture path escaped its controlled directory');
    }
    return target;
  }

  async function launch() {
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
      windowsHide: true,
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
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as {
      Browser?: string;
    };
    browserVersion ??= version.Browser ?? null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    instances.push({ child, browser });
    const context = browser.contexts()[0]!;
    await context.setOffline(true);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    await expect(page).toHaveTitle('轻羽 FeatherPad');
    expect(page.url()).toMatch(/^https?:\/\/tauri\.localhost\//);
    await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeVisible();
    const launchEvidence = path.join(evidence, `launch-${instances.length}`);
    await mkdir(launchEvidence, { recursive: true });
    const chooser = new NativeChooser({
      page,
      child,
      dataDir,
      executable,
      executableSha256,
      evidence: launchEvidence,
      cleanupTasks: [],
    });
    return { page, child, browser, chooser };
  }

  async function stop(app: {
    child: ChildProcess;
    browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  }) {
    if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
    await expect.poll(() => app.child.exitCode !== null || app.child.signalCode !== null).toBe(true);
  }

  async function readProfile(): Promise<StoredProfile | null> {
    try {
      return JSON.parse(await readFile(settingsFile, 'utf8')) as StoredProfile;
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null;
      throw error;
    }
  }

  async function storedEntries() {
    return (await readProfile())?.settings.recentHistoryItems?.entries ?? [];
  }

  async function openFile(page: Page, chooser: NativeChooser, file: string) {
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    await chooser.select('open', file);
  }

  try {
    const original = ownedFixture(path.join(dataDir, 'original.txt'));
    const repaired = ownedFixture(path.join(dataDir, 'repair.txt'));
    const moved = ownedFixture(path.join(dataDir, 'original-moved.txt'));
    const newer = ownedFixture(path.join(dataDir, 'newer.txt'));
    const workspace = ownedFixture(path.join(dataDir, 'workspace-folder'));
    const originalBody = 'RECENT_FILE_BODY_PRIVATE_TOKEN';
    const searchToken = 'RECENT_SEARCH_PRIVATE_TOKEN';
    await writeFile(original, originalBody, 'utf8');
    await writeFile(repaired, 'repaired file content', 'utf8');
    await writeFile(newer, 'new file while history is disabled', 'utf8');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'inside.txt'), 'workspace content', 'utf8');

    let app = await launch();
    await openFile(app.page, app.chooser, original);
    await expect(app.page.locator('.cm-content')).toHaveText(originalBody);
    await app.page.keyboard.press('Control+f');
    const find = app.page.getByRole('region', { name: '文件内查找替换' });
    await find.getByRole('textbox', { name: '查找内容', exact: true }).fill(searchToken);
    await find.getByRole('button', { name: '关闭查找', exact: true }).click();

    await app.page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await app.chooser.select('open-folder', workspace);
    await expect(app.page.getByRole('tree', { name: 'workspace-folder 文件树', exact: true })).toBeVisible();
    await expect.poll(async () => (await storedEntries()).length).toBe(2);

    const firstProfile = await readProfile();
    const firstEntries = firstProfile?.settings.recentHistoryItems?.entries ?? [];
    const fileEntry = firstEntries.find(entry => entry.kind === 'file');
    const workspaceEntry = firstEntries.find(entry => entry.kind === 'workspace');
    expect(fileEntry).toMatchObject({
      kind: 'file',
      title: 'original.txt',
      ref: { relativePath: '' },
    });
    expect(fileEntry?.canonicalIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(workspaceEntry).toMatchObject({
      kind: 'workspace',
      title: 'workspace-folder',
    });
    expect([...firstEntries].map(entry => entry.kind).sort()).toEqual(['file', 'workspace']);
    const serialized = JSON.stringify(firstProfile);
    expect(serialized).not.toContain(originalBody);
    expect(serialized).not.toContain(searchToken);
    expect(serialized.toLowerCase()).not.toContain('clipboard');
    for (const entry of firstEntries) {
      expect(Object.keys(entry).sort()).toEqual([
        'canonicalIdentity', 'displayPath', 'id', 'kind', 'lastOpenedAt', 'ref', 'title',
      ]);
      expect(Object.keys(entry.ref).sort()).toEqual(['grantId', 'relativePath']);
    }
    const committedGrants = async () => {
      try { return await readFile(grantsFile, 'utf8'); }
      catch (error: unknown) {
        // First persistence and atomic replacement may briefly have no pathname.
        // Other IO errors must still fail, and both durable grant assertions remain.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
        throw error;
      }
    };
    await expect.poll(committedGrants).toContain(fileEntry!.ref.grantId);
    await expect.poll(committedGrants).toContain(workspaceEntry!.ref.grantId);
    await app.page.screenshot({ path: path.join(evidence, 'recent-recorded.png') });
    await stop(app);

    app = await launch();
    const recent = app.page.locator('.recent-panel');
    await expect(recent.getByRole('button', { name: '打开original.txt', exact: true })).toBeVisible();
    await recent.getByRole('button', { name: '打开original.txt', exact: true }).click();
    await expect(app.page.locator('.cm-content')).toHaveText(originalBody);
    await recent.getByRole('button', { name: '打开workspace-folder', exact: true }).click();
    await expect(app.page.getByRole('tree', { name: 'workspace-folder 文件树', exact: true })).toBeVisible();
    await stop(app);

    await rename(original, moved);
    app = await launch();
    let missingRecent = app.page.locator('.recent-panel');
    const missingRow = missingRecent.locator('li').filter({ hasText: 'original.txt' });
    await expect(missingRow).toHaveAttribute('data-missing', 'true');
    await missingRow.getByRole('button', { name: '重试打开original.txt', exact: true }).click();
    await expect(missingRow).toHaveAttribute('data-missing', 'true');
    await missingRow.getByRole('button', { name: '重新选择', exact: true }).click();
    await app.chooser.select('open', repaired);
    await expect(app.page.locator('.cm-content')).toHaveText('repaired file content');
    await expect(missingRecent.getByRole('button', { name: '打开repair.txt', exact: true })).toBeVisible();
    await expect(missingRecent.getByText('original.txt', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await storedEntries()).map(entry => entry.title).sort())
      .toEqual(['repair.txt', 'workspace-folder']);

    await stop(app);
    app = await launch();
    missingRecent = app.page.locator('.recent-panel');
    await expect(missingRecent.getByRole('button', { name: '打开repair.txt', exact: true })).toBeVisible();
    const repairedRow = missingRecent.locator('li').filter({ hasText: 'repair.txt' });
    const removeRepaired = repairedRow.getByRole('button').filter({ hasText: '移除' });
    await expect(removeRepaired).toBeVisible();
    await expect(removeRepaired).toBeEnabled();
    await removeRepaired.evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(async () => (await storedEntries()).map(entry => entry.title))
      .toEqual(['workspace-folder']);

    await app.page.getByRole('button', { name: '打开设置', exact: true }).click();
    const settingsDialog = app.page.getByRole('dialog', { name: '设置', exact: true });
    const historyEnabled = settingsDialog.getByRole('checkbox', { name: '记录最近打开', exact: true });
    await expect(historyEnabled).toBeChecked();
    await historyEnabled.uncheck();
    await settingsDialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settingsDialog.getByRole('status')).toContainText('设置已保存');
    await settingsDialog.getByRole('button', { name: '取消并还原预览', exact: true }).click();
    await expect(missingRecent.getByRole('note')).toContainText('最近记录已关闭');
    await expect.poll(async () => ({ enabled: (await readProfile())?.settings.recentHistoryEnabled,
      titles: (await storedEntries()).map(entry => entry.title) })).toEqual({
      enabled: false,
      titles: ['workspace-folder'],
    });
    const disabledVersion = (await readProfile())!.version;
    await stop(app);

    app = await launch();
    const disabledRecent = app.page.locator('.recent-panel');
    await expect(disabledRecent.getByRole('note')).toContainText('已有条目保留');
    await expect(disabledRecent.getByRole('button', { name: '打开workspace-folder', exact: true })).toBeVisible();
    await openFile(app.page, app.chooser, newer);
    await expect(app.page.locator('.cm-content')).toHaveText('new file while history is disabled');
    await expect(disabledRecent.getByText('newer.txt', { exact: true })).toHaveCount(0);
    await app.page.waitForTimeout(300);
    const afterDisabledOpen = await readProfile();
    expect(afterDisabledOpen?.version).toBe(disabledVersion);
    expect(afterDisabledOpen?.settings.recentHistoryItems?.entries.map(entry => entry.title))
      .toEqual(['workspace-folder']);

    await disabledRecent.getByRole('button', { name: '清空', exact: true }).click();
    await disabledRecent.getByRole('button', { name: '确认清空最近记录', exact: true }).click();
    await expect(disabledRecent.locator('[data-recent-kind]')).toHaveCount(0);
    await expect.poll(async () => (await storedEntries()).length).toBe(0);
    const finalProfile = await readProfile();
    expect(finalProfile?.settings.recentHistoryEnabled).toBe(false);
    expect(finalProfile?.settings.recentHistoryItems).toEqual({ schemaVersion: 1, entries: [] });
    await app.page.screenshot({ path: path.join(evidence, 'recent-cleared-privacy.png') });
    const finalSettingsBytes = await readFile(settingsFile);
    await writeFile(path.join(evidence, 'native-release.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      executable,
      executableBytes: executableStat.size,
      executableSha256,
      browserVersion,
      dataDir,
      scope: 'Real Tauri/WebView2 settings storage, persisted grants and native file/folder choosers; no mock bridge',
      successfulFileAndWorkspaceOpensPersist: true,
      canonicalFileIdentityPersisted: true,
      restartRestoresFileAndWorkspaceGrantOpens: true,
      movedFileIsMarkedMissingAndReselectRepairsHistory: true,
      singleRemovalPersistsImmediately: true,
      disabledHistoryPreservesExistingEntriesAndSkipsNewWrites: true,
      disabledHistorySurvivesRestart: true,
      clearPersistsImmediately: true,
      persistedBodySearchOrClipboardContent: false,
      entryFields: ['id', 'kind', 'canonicalIdentity', 'ref', 'title', 'displayPath', 'lastOpenedAt'],
      finalSettingsSha256: sha256(finalSettingsBytes),
      finalSettingsVersion: finalProfile?.version,
    }, null, 2));
    await stop(app);
  } finally {
    for (const app of instances) {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
      if (app.browser.isConnected()) await app.browser.close().catch(() => {});
    }
  }
});

import { expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type ChooseDestination = (action: 'save' | 'cancel', destination?: string) => Promise<void>;

async function holdFixture(dataDir: string, source: string, token: string) {
  const ready = path.join(dataDir, `trash-lock-${token}.ready`);
  const release = path.join(dataDir, `trash-lock-${token}.release`);
  const child = spawn('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/Hold-ControlledFixture.ps1'),
    '-Path', source, '-Ready', ready, '-Release', release], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Owned fixture lock exited ${child.exitCode}: ${stderr}`);
      return readFile(ready, 'utf8').catch(() => '');
    }, { timeout: 10_000 }).toBe('ready');
  } catch (error) { child.kill(); throw error; }
  return async () => {
    await writeFile(release, 'release');
    try { await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0); }
    finally { if (child.exitCode === null) child.kill(); }
  };
}

async function protectedDraft(dataDir: string, source: string, text: string) {
  const recovery = path.join(dataDir, 'featherpad-state', 'recovery');
  for (const receipt of await readdir(recovery)) {
    if (!/^[0-9a-f-]{36}$/.test(receipt)) continue;
    const directory = path.join(recovery, receipt);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
      sourcePath: string; documentId: string; bufferVersion: number; bodySha256: string;
    };
    if (!manifest.sourcePath.replaceAll('\\', '/').endsWith(source.replaceAll('\\', '/'))) continue;
    const body = await readFile(path.join(directory, 'body.bin'));
    if (body.toString('utf8') !== text) continue;
    expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.bodySha256);
    expect(manifest.bufferVersion).toBeGreaterThan(0);
    return { receipt, documentId: manifest.documentId, bodySha256: manifest.bodySha256 };
  }
  throw new Error('Verified before-trash draft was not found in the owned private store');
}

export async function verifyNativeTrash(page: Page, dataDir: string, root: string, chooseDestination: ChooseDestination,
  grant: { grantId: string; relativePath: string }) {
  const evidence = path.join(dataDir, 'evidence', 'trash');
  await mkdir(evidence, { recursive: true });
  const token = randomUUID();
  const name = `trash-lock-${token}.txt`;
  const source = path.join(root, name);
  await writeFile(source, '原生回收原件', 'utf8');
  const rejected = await page.evaluate(async ({ grant, name, source }) => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, request: Record<string, unknown>) => Promise<unknown> };
    const base = { ref: { grantId: 'not-issued', relativePath: 'controlled.txt' }, expectedRevision: 'a'.repeat(64),
      expectedIdentity: 'b'.repeat(64), requestId: crypto.randomUUID(), affectedDocumentIds: [], snapshots: [] };
    const unauthorized = await native.invoke('trash_entry', base) as { error?: { code?: string } };
    const malformed = await native.invoke('trash_entry', { ...base, path: source }) as { error?: { code?: string } };
    const stale = await native.invoke('get_trash_impact', { ref: { ...grant, relativePath: name }, expectedRevision: '0'.repeat(64) }) as { error?: { code?: string } };
    const junction = await native.invoke('get_trash_impact', { ref: { ...grant, relativePath: '外部链接' }, expectedRevision: 'a'.repeat(64) }) as { error?: { code?: string } };
    return { unauthorized: unauthorized.error?.code, malformed: malformed.error?.code, stale: stale.error?.code, junction: junction.error?.code };
  }, { grant, name, source });
  expect(rejected).toEqual({ unauthorized: 'OUT_OF_SCOPE', malformed: 'INVALID_INPUT', stale: 'CONFLICT', junction: 'UNSUPPORTED' });
  expect(await readFile(source, 'utf8')).toBe('原生回收原件');
  await page.getByRole('button', { name: '刷新目录树', exact: true }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' dirty😀');
  const intended = '原生回收原件 dirty😀';
  const unlock = await holdFixture(dataDir, source, token);
  try {
    await page.getByRole('button', { name: '移至回收站', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '移至回收站' });
    await expect(dialog).toContainText('1 个有未保存修改');
    await dialog.getByRole('button', { name: '保留草稿并移至回收站' }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法确认项目可安全移至回收站');
    expect(await readFile(source, 'utf8')).toBe('原生回收原件');
    await page.screenshot({ path: path.join(evidence, 'native-trash-sharing-failure.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
    await expect(editor).toHaveText(intended);
  } finally { await unlock(); }
  const failedDraft = await protectedDraft(dataDir, source, intended);
  await page.getByRole('button', { name: '移至回收站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移至回收站' });
  await expect(dialog).toContainText('1 个有未保存修改');
  await dialog.getByRole('button', { name: '保存修改并重新确认' }).click();
  await expect(dialog).toContainText('0 个有未保存修改');
  expect(await readFile(source, 'utf8')).toBe(intended);
  await dialog.getByRole('button', { name: '移至回收站', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('treeitem', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('note')).toContainText('文件已移至回收站');
  await expect(editor).toHaveText(intended);
  expect(await stat(source).then(() => true, () => false)).toBe(false);
  await editor.focus();
  await page.keyboard.press('Control+s');
  const destination = path.join(dataDir, `回收后另存-${token}.txt`);
  await chooseDestination('save', destination);
  await expect(page.getByRole('status')).toContainText('未修改');
  expect(await readFile(destination, 'utf8')).toBe(intended);
  await expect(page.getByRole('note')).toHaveCount(0);

  const folderName = `回收目录-${token}`;
  const folder = path.join(root, folderName);
  const nestedName = `回收后代-${token}.txt`;
  const nested = path.join(folder, nestedName);
  await mkdir(folder);
  await writeFile(nested, '目录后代原件', 'utf8');
  await page.getByRole('button', { name: '刷新目录树', exact: true }).click();
  const folderRow = page.getByRole('treeitem', { name: folderName, exact: true });
  await folderRow.click();
  await page.getByRole('treeitem', { name: nestedName, exact: true }).click();
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' 未保存后代😀');
  const nestedText = '目录后代原件 未保存后代😀';
  await folderRow.press('Delete');
  const directoryDialog = page.getByRole('dialog', { name: '移至回收站' });
  await expect(directoryDialog).toContainText('文件夹及其中全部内容');
  await expect(directoryDialog).toContainText('1 个有未保存修改');
  await page.screenshot({ path: path.join(evidence, 'native-trash-directory-confirmation.png') });
  await page.keyboard.press('Escape');
  expect(await readFile(nested, 'utf8')).toBe('目录后代原件');
  await folderRow.press('Delete');
  await directoryDialog.getByRole('button', { name: '保留草稿并移至回收站' }).click();
  await expect(directoryDialog).not.toBeVisible();
  await expect(page.getByRole('treeitem', { name: folderName, exact: true })).toHaveCount(0);
  await expect(editor).toHaveText(nestedText);
  await expect(page.getByRole('note')).toContainText('草稿已获得落盘保护');
  expect(await stat(folder).then(() => true, () => false)).toBe(false);
  const directoryDraft = await protectedDraft(dataDir, nested, nestedText);
  await page.screenshot({ path: path.join(evidence, 'native-trash-missing-buffer.png') });
  return { nativeRecycleSharingFailurePreservesSourceAndTree: true, nativeTrashDraftVerified: true,
    nativeTrashInvalidRequestsRejected: true,
    nativeSaveBeforeTrashRefreshesIdentity: true, nativeTrashMissingBufferCanSaveAs: true,
    nativeDirectoryTrashWithDirtyDescendant: true, nativeDirectoryTrashCancellationPreservesSource: true,
    failedDraft, directoryDraft,
    recycledFixtures: [source, folder],
    scope: 'real Release/Tauri/Shell, private recovery files and OS Save As; controlled recycle-bin items retained; no user-bin enumeration or cleanup' };
}

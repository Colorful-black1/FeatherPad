import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Choose = (action: 'open' | 'open-folder' | 'save' | 'cancel', target?: string) => Promise<void>;
const editor = (page: Page) => page.locator('.cm-content');
const closing = (page: Page) => page.getByRole('dialog', { name: '关闭文档', exact: true });

async function documentId(page: Page, name: string) {
  const id = await page.getByRole('tab', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).getAttribute('id');
  if (!id?.startsWith('tab-')) throw new Error('Native document identity missing');
  return id.slice(4);
}
async function nativeStat(page: Page, documentId: string) {
  return page.evaluate(async documentId => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    return native.invoke('stat_document', { documentId });
  }, documentId);
}
async function exists(target: string) {
  try { await stat(target); return true; }
  catch (error) { if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return false; throw error; }
}
async function append(page: Page, text: string) {
  await editor(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}
async function sourceDraft(dataDir: string, id: string) {
  const root = path.join(dataDir, 'featherpad-state', 'recovery');
  for (const receipt of await readdir(root)) {
    if (!/^[0-9a-f-]{36}$/.test(receipt)) continue;
    const directory = path.join(root, receipt);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
      documentId: string; bufferVersion: number; bodySha256: string;
    };
    if (manifest.documentId !== id) continue;
    const body = await readFile(path.join(directory, 'body.bin'));
    expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.bodySha256);
    return { directory, receipt, manifest, body };
  }
  throw new Error('Owned native recovery draft missing');
}

export async function verifyNativeTabs(page: Page, dataDir: string, evidence: string, choose: Choose) {
  const root = path.join(dataDir, 'T107 标签关闭😀');
  await mkdir(root);
  for (const [name, text] of [['a.txt', '甲原文😀'], ['b.txt', '乙原文😀'], ['c.txt', '丙原文😀'],
    ['trash.txt', '回收前原文😀'], ['unknown.txt', '未知回执原件😀']]) await writeFile(path.join(root, name!), text!, 'utf8');
  async function openFolder() {
    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await choose('open-folder', root);
    await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
  }
  async function openTree(name: string) {
    await page.getByRole('treeitem', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toHaveAttribute('aria-selected', 'true');
  }
  await openFolder();
  await openTree('a.txt');
  const oldA = await documentId(page, 'a.txt');
  await openTree('b.txt');
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await nativeStat(page, oldA)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).dblclick();
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await openTree('a.txt');
  const freshA = await documentId(page, 'a.txt');
  expect(freshA).not.toBe(oldA);
  const intended = '甲原文😀 保留修改';
  await append(page, ' 保留修改');
  await openTree('c.txt');
  await page.getByRole('tab', { name: /a\.txt/ }).click();
  await expect(editor(page)).toHaveText(intended);
  await editor(page).focus();
  await page.keyboard.press('Control+z');
  await expect(editor(page)).toHaveText('甲原文😀');
  await page.keyboard.press('Control+y');
  await expect(editor(page)).toHaveText(intended);
  await page.keyboard.press('Control+w');
  await expect(closing(page).getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(closing(page)).toHaveCount(0);
  await expect(editor(page)).toHaveText(intended);

  const external = '受控外部修改，不能覆盖😀';
  await writeFile(path.join(root, 'a.txt'), external, 'utf8');
  await editor(page).focus();
  await page.keyboard.press('Control+w');
  await closing(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toContainText('磁盘文件已变化');
  expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe(external);
  await page.screenshot({ path: path.join(evidence, 'native-close-save-conflict.png') });
  await closing(page).getByRole('button', { name: '取消', exact: true }).click();
  const retainedCopy = path.join(dataDir, 'T107 冲突保留副本😀.txt');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await choose('save', retainedCopy);
  await expect(page.getByRole('status')).toContainText('未修改');
  expect(await readFile(retainedCopy, 'utf8')).toBe(intended);
  await editor(page).focus();
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab', { name: /冲突保留副本/ })).toHaveCount(0);

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const untitled = '关闭前原生草稿😀';
  await page.keyboard.insertText(untitled);
  await page.keyboard.press('Control+w');
  await closing(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await choose('cancel');
  await expect(closing(page).getByRole('alert')).toContainText('保存已取消');
  const untitledPath = path.join(dataDir, 'T107 关闭前保存😀.txt');
  await closing(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await choose('save', untitledPath);
  await expect(closing(page)).toHaveCount(0);
  expect(await readFile(untitledPath, 'utf8')).toBe(untitled);

  await openTree('trash.txt');
  await append(page, ' 待放弃草稿');
  const trashedId = await documentId(page, 'trash.txt');
  await page.getByRole('button', { name: '移至回收站', exact: true }).click();
  const trash = page.getByRole('dialog', { name: '移至回收站', exact: true });
  await trash.getByRole('button', { name: '保留草稿并移至回收站', exact: true }).click();
  await expect(trash).toHaveCount(0);
  await expect(page.getByRole('note')).toContainText('草稿已获得落盘保护');
  const draft = await sourceDraft(dataDir, trashedId);
  expect(draft.body.toString('utf8')).toBe('回收前原文😀 待放弃草稿');
  expect(await exists(path.join(root, 'trash.txt'))).toBe(false);
  await editor(page).focus();
  await page.keyboard.press('Control+w');
  await closing(page).getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(page.getByRole('tab', { name: /trash\.txt/ })).toHaveCount(0);
  expect(await exists(draft.directory)).toBe(false);
  const marker = path.join(dataDir, 'featherpad-state', 'recovery', `discarded-${trashedId}`, `${draft.manifest.bufferVersion}.json`);
  expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ documentId: trashedId, throughVersion: draft.manifest.bufferVersion });

  await openTree('unknown.txt');
  await append(page, ' 当前副本');
  const unknownId = await documentId(page, 'unknown.txt');
  await page.evaluate(id => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
      callbacks: Map<number, (value: unknown) => void>;
      runCallback: (id: number, value: unknown) => void;
    };
    // Tauri's invoke property is immutable. Observe the real protocol response and reject only
    // its renderer callback; the native command and all filesystem work still run normally.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'ipc.localhost' && url.pathname === '/release_document'
        && typeof init?.body === 'string' && JSON.parse(init.body).documentId === id) {
        window.fetch = originalFetch;
        const headers = new Headers(init.headers);
        const callbackId = Number(headers.get('Tauri-Callback'));
        const errorId = Number(headers.get('Tauri-Error'));
        const onSuccess = native.callbacks.get(callbackId);
        if (!onSuccess || !native.callbacks.has(errorId)) throw new Error('Real native callbacks missing');
        native.callbacks.set(callbackId, result => {
          if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true
            || Reflect.get(result, 'value')?.released !== true) { onSuccess(result); return; }
          Reflect.set(window, 'nativeReleaseAckDropped', true);
          native.runCallback(errorId, 'Controlled transport failure after the real lease release');
        });
      }
      return originalFetch(input, init);
    };
  }, unknownId);
  await page.keyboard.press('Control+w');
  await closing(page).getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(closing(page).getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'nativeReleaseAckDropped'))).toBe(true);
  expect(await nativeStat(page, unknownId)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  await closing(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveText('未知回执原件😀 当前副本');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  const uncertainCopy = path.join(dataDir, 'T107 未知回执保留副本😀.txt');
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await choose('save', uncertainCopy);
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  expect(await readFile(uncertainCopy, 'utf8')).toBe('未知回执原件😀 当前副本');
  expect(await readFile(path.join(root, 'unknown.txt'), 'utf8')).toBe('未知回执原件😀');
  await editor(page).focus();
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab', { name: /未知回执保留副本/ })).toHaveCount(0);

  await page.getByRole('tab', { name: 'b.txt', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'native-pinned-tabs.png') });
  // Renderer reload is abrupt; wait for the existing asynchronous session write
  // so this pin-metadata check does not restore an older, already closed tab.
  await expect.poll(async () => {
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'featherpad-state/session/manifest.json'), 'utf8')) as {
      windows: { windowId: string; views: { title: string }[] }[];
    };
    return manifest.windows.find(window => window.windowId === 'main')?.views.map(view => view.title);
  }).toEqual(['b.txt']);
  await page.reload(); // All remaining buffers are clean; this verifies pin metadata, not session recovery.
  await openFolder();
  await openTree('b.txt');
  await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await page.getByRole('button', { name: '关闭 b.txt', exact: true }).click();
  await expect(page.getByRole('heading', { name: '快开文件，专心编辑。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建文本', exact: true })).toBeFocused();
  return { nativeCleanPreviewLeaseReleased: true, nativeDirtyTabCancelAndUndoPreserved: true,
    nativeClosingSaveConflictPreservesExternal: true, nativeUntitledClosingSaveAndCancel: true,
    nativeDiscardClearsVerifiedRecoveryDraft: true, discardedReceipt: draft.receipt,
    nativeUnknownReleaseRetainsCopyAndCanSaveAs: true, nativePinMetadataSurvivesRendererReload: true,
    retainedCopySha256: createHash('sha256').update(await readFile(retainedCopy)).digest('hex'),
    untitledSha256: createHash('sha256').update(await readFile(untitledPath)).digest('hex'),
    uncertainCopySha256: createHash('sha256').update(await readFile(uncertainCopy)).digest('hex'),
    recycledFixtures: [path.join(root, 'trash.txt')],
    scope: 'Real Release/Tauri/OS selectors/IO and recovery cleanup; test-only transport rejection after a real lease release; renderer reload pin metadata, not startup session recovery or OS scaling' };
}

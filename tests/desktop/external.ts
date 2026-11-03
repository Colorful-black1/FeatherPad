import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyNativeExternal(page: Page, dataDir: string, evidence: string,
  nativeAction: (action: 'open' | 'save' | 'inspect-external' | 'confirm-external' | 'reject-external', target: string) => Promise<void>) {
  const owned = (name: string) => {
    const target = path.resolve(dataDir, name);
    if (!target.startsWith(`${path.resolve(dataDir)}${path.sep}`)) throw new Error('Fixture escaped native root');
    return target;
  };
  const source = owned('外部变化😀.txt');
  const renamed = owned('外部改名😀.txt');
  const afterRename = owned('另存改名后的正文.txt');
  const afterDelete = owned('另存删除后的正文.txt');
  const editor = () => page.locator('.document-view .codemirror-host .cm-content');
  const banner = () => page.getByRole('region', { name: '外部文件变化', exact: true });
  const stamp = new Date('2026-11-02T00:00:00.000Z');
  const hashes: Record<string, string> = {};
  async function append(text: string) { await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text); }
  async function remember(name: string, target: string) { hashes[name] = createHash('sha256').update(await readFile(target)).digest('hex'); }
  async function readCreated(target: string) {
    try { return await readFile(target, 'utf8'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  }
  async function readWithoutTransientLock(target: string) {
    try { return await readFile(target, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'EBUSY' || error.code === 'EPERM')) return null;
      throw error;
    }
  }

  // Observe actual subscriptions without replacing any native result or filesystem IO.
  await page.evaluate(() => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { callbacks: Map<number, (data: unknown) => void> };
    const callbacks = native.callbacks;
    if (!(callbacks instanceof Map)) throw new Error('Framework callback table unavailable');
    const overflowListeners: Array<(watchId: string) => void> = [];
    Reflect.set(window, 'nativeExternalOverflowListeners', overflowListeners);
    const get = callbacks.get;
    callbacks.get = function (id) {
      const callback = get.call(this, id);
      if (!callback) return callback;
      return data => {
        if (data && typeof data === 'object') {
          if ('ok' in data && data.ok && 'value' in data && data.value && typeof data.value === 'object' && 'watchId' in data.value) {
            Reflect.set(window, 'nativeExternalSubscription', data.value);
          }
          if ('event' in data && data.event === 'filesystem_changed') {
            overflowListeners.push((watchId: string) => callback({ ...data,
              payload: { watchId, sequence: 9000, entries: [], overflow: true } }));
          }
        }
        callback(data);
      };
    };
  });

  await writeFile(source, 'one00', 'utf8'); await utimes(source, stamp, stamp);
  await page.getByRole('button', { name: '打开文件', exact: true }).click(); await nativeAction('open', source);
  await expect(editor()).toHaveText('one00');
  const tabId = await page.getByRole('tab', { name: /外部变化😀.txt/ }).getAttribute('id');
  const documentId = tabId!.slice('tab-'.length);
  const before = await stat(source, { bigint: true });
  await writeFile(source, 'two00', 'utf8'); await utimes(source, stamp, stamp);
  const after = await stat(source, { bigint: true });
  expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs);
  await expect(editor()).toHaveText('two00');
  await expect(banner()).toContainText('自动重新载入');
  await expect(page.getByRole('tab', { name: /外部变化😀.txt/ })).toHaveAttribute('id', tabId!);
  await banner().getByRole('button', { name: '知道了' }).click();

  const previousObject = owned('原子替换前的对象.txt');
  await rename(source, previousObject);
  await writeFile(source, 'new object', 'utf8');
  await expect(editor()).toHaveText('new object');
  await expect(page.getByRole('tab', { name: /外部变化😀.txt/ })).toHaveAttribute('id', tabId!);
  expect(await readFile(previousObject, 'utf8')).toBe('two00');
  await banner().getByRole('button', { name: '知道了' }).click();
  await append(' 我的草稿');
  const draft = 'new object 我的草稿';
  await writeFile(source, '外部第一版', 'utf8');
  await expect(banner()).toContainText('磁盘文件已变化'); await expect(editor()).toHaveText(draft);
  await banner().getByRole('button', { name: '比较磁盘', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '比较当前缓冲与磁盘', exact: true });
  await expect(comparison.getByLabel('当前缓冲快照', { exact: true })).toHaveText(draft);
  await expect(comparison.getByLabel('磁盘快照', { exact: true })).toHaveText('外部第一版');
  await expect(comparison.getByLabel('磁盘快照', { exact: true })).toHaveAttribute('contenteditable', 'false');
  await page.screenshot({ path: path.join(evidence, 'native-release-external-comparison.png') });
  const compared = await page.evaluate(async id => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    return await native.invoke('get_disk_snapshot', { documentId: id }) as { ok: true; value: { metadata: { diskRevision: string } } };
  }, tabId!.replace(/^tab-/, ''));
  expect(compared.ok).toBe(true);
  await writeFile(source, '比较之后再次修改', 'utf8');
  await expect(comparison.getByRole('button', { name: '保护草稿并重新载入', exact: true })).toBeDisabled();
  await expect(comparison.getByRole('status').filter({ hasText: '版本已有新变化' })).toBeVisible();
  const staleReload = await page.evaluate(async ({ id, revision }) => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    return await native.invoke('reload_document', { documentId: id, expectedDiskRevision: revision });
  }, { id: tabId!.replace(/^tab-/, ''), revision: compared.value.metadata.diskRevision });
  expect(staleReload).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(await readFile(source, 'utf8')).toBe('比较之后再次修改');
  await expect(editor()).toHaveText(draft);
  await comparison.getByRole('button', { name: '保留当前内容' }).click();

  await banner().getByRole('button', { name: '重新核对', exact: true }).click();
  await banner().getByRole('button', { name: '重新载入…', exact: true }).click();
  await page.getByRole('dialog', { name: '重新载入磁盘文件', exact: true })
    .getByRole('button', { name: '保护草稿并重新载入', exact: true }).click();
  await expect(editor()).toHaveText('比较之后再次修改');
  const protectedBodies = await page.evaluate(async id => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    const inventory = await native.invoke('list_recovery_entries', {}) as { ok: boolean; value: { entries: { documentId: string; receiptId: string }[] } };
    if (!inventory.ok) throw new Error('Native recovery scan failed');
    const entries = inventory.value.entries.filter(entry => entry.documentId === id);
    const bodies: string[] = [];
    // Recovery reads share the store's exclusive consistency lock; inspect sequentially.
    for (const entry of entries) {
      const loaded = await native.invoke('load_recovery_entry', { receiptId: entry.receiptId }) as {
        ok: boolean; value: { text: string }; error?: { code: string; message: string };
      };
      if (!loaded.ok) throw new Error(`Native draft load failed: ${loaded.error?.code}: ${loaded.error?.message}`);
      bodies.push(loaded.value.text);
    }
    return bodies;
  }, documentId);
  expect(protectedBodies).toContain(draft);
  await banner().getByRole('button', { name: '知道了' }).click();

  await append(' 最终缓冲');
  const finalDraft = '比较之后再次修改 最终缓冲';
  await writeFile(source, '确认覆盖前的磁盘', 'utf8');
  await expect(banner()).toContainText('磁盘文件已变化');
  await banner().getByRole('button', { name: '覆盖磁盘…', exact: true }).click();
  await nativeAction('reject-external', source);
  expect(await readFile(source, 'utf8')).toBe('确认覆盖前的磁盘'); await expect(editor()).toHaveText(finalDraft);
  await banner().getByRole('button', { name: '覆盖磁盘…', exact: true }).click();
  await nativeAction('inspect-external', source);
  await writeFile(source, '确认对话框期间再次变化', 'utf8');
  await nativeAction('confirm-external', source);
  await expect(page.getByRole('alert')).toContainText('再次变化');
  expect(await readFile(source, 'utf8')).toBe('确认对话框期间再次变化');
  await expect(editor()).toHaveText(finalDraft);
  await banner().getByRole('button', { name: '重新核对', exact: true }).click();
  await banner().getByRole('button', { name: '覆盖磁盘…', exact: true }).click();
  await nativeAction('confirm-external', source);
  await expect.poll(() => readWithoutTransientLock(source)).toBe(finalDraft);
  await expect(page.getByRole('status')).toContainText('未修改');
  await remember('explicitOverwrite', source);

  await rename(source, renamed);
  await expect(banner()).toContainText('不存在'); await expect(editor()).toHaveText(finalDraft);
  await banner().getByRole('button', { name: '另存当前内容…', exact: true }).click(); await nativeAction('save', afterRename);
  await expect.poll(() => readCreated(afterRename)).toBe(finalDraft);
  expect(await readFile(renamed, 'utf8')).toBe(finalDraft);
  await remember('renamedOriginal', renamed);
  await unlink(afterRename);
  await expect(banner()).toContainText('不存在'); await expect(editor()).toHaveText(finalDraft);
  await page.keyboard.press('Control+s'); await nativeAction('save', afterDelete);
  await expect.poll(() => readCreated(afterDelete)).toBe(finalDraft);
  await expect(page.getByRole('status')).toContainText('未修改');
  await remember('afterExternalDeleteSaveAs', afterDelete);
  await page.evaluate(async () => {
    const value = Reflect.get(window, 'nativeExternalSubscription') as { watchId?: string } | undefined;
    if (!value?.watchId) throw new Error('Real watcher subscription was not observed');
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
      invoke: (command: string, args: Record<string, unknown>) => Promise<{ ok: boolean; value: { stopped: boolean } }>;
    };
    const stopped = await native.invoke('stop_watch', { watchId: value.watchId });
    if (!stopped.ok || !stopped.value.stopped) throw new Error('Owned watcher was not stopped');
  });
  await writeFile(afterDelete, '聚焦核对读取的实际磁盘正文', 'utf8');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(editor()).toHaveText('聚焦核对读取的实际磁盘正文');
  await remember('focusFallbackDisk', afterDelete);
  await writeFile(afterDelete, '溢出通知之后读取的实际磁盘正文', 'utf8');
  await page.evaluate(() => {
    const subscription = Reflect.get(window, 'nativeExternalSubscription') as { watchId: string };
    const listeners = Reflect.get(window, 'nativeExternalOverflowListeners') as Array<(watchId: string) => void>;
    if (!Array.isArray(listeners) || listeners.length === 0) throw new Error('Real filesystem listener callbacks were not observed');
    for (const overflow of listeners) overflow(subscription.watchId);
  });
  await expect(editor()).toHaveText('溢出通知之后读取的实际磁盘正文');
  await remember('overflowFallbackDisk', afterDelete);
  await page.screenshot({ path: path.join(evidence, 'native-release-external-final.png') });
  return { realWatcherEditRenameDelete: true, sameSizeSameMtime: true, sourceDocumentIdRetained: true, externalObjectReplacementReloaded: true,
    comparisonReadonly: true, staleReloadRefused: true, draftProtectionReadBack: true,
    nativeOverwriteCancelAndStaleConfirmation: true, explicitOverwriteBytes: true,
    missingBufferSavedThroughNativeChooser: true, hashes,
    focusFallbackRealStat: 'Real watcher stopped through IPC, DOM focus event injected; actual disk reload verified',
    overflowFallbackRealStat: 'Overflow notification injected into observed real listener; actual disk reload verified; OS overflow not claimed' };
}

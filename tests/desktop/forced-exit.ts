import { expect, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function verifyNativeForcedExit(page: Page, child: ChildProcess, dataDir: string) {
  const target = path.join(dataDir, '硬链接 原路径😀.txt');
  const baseline = await readFile(target, 'utf8');
  const appended = ` 强杀已提交内容 ${randomUUID()}`;
  await page.getByRole('tab', { name: /硬链接 原路径😀.txt/ }).click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(appended);
  await page.evaluate(() => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { callbacks: Map<number, (data: unknown) => void> };
    const callbacks = native.callbacks;
    if (!(callbacks instanceof Map)) throw new Error('Framework callback table unavailable');
    const originalSet = callbacks.set;
    let held = false;
    callbacks.set = function (id, callback) {
      originalSet.call(this, id, data => {
        const value: unknown = data && typeof data === 'object' ? Reflect.get(data, 'value') : null;
        const isAck = data && typeof data === 'object' && Reflect.get(data, 'ok') === true
          && value && typeof value === 'object' && typeof Reflect.get(value, 'documentVersion') === 'number'
          && typeof Reflect.get(value, 'diskRevision') === 'string';
        if (isAck && !held) {
          held = true;
          callbacks.set = originalSet;
          Reflect.set(window, 'nativeForcedExitAckHeld', true);
          Reflect.set(window, 'nativeForcedExitVersion', Reflect.get(value, 'documentVersion'));
          // Keep the real committed Ack unmodified and undelivered; this process will be killed.
        } else callback(data);
      });
      return this;
    };
  });
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'nativeForcedExitAckHeld') === true)).toBe(true);
  await expect(page.getByRole('status')).toContainText('正在保存');
  const version = await page.evaluate(() => Reflect.get(window, 'nativeForcedExitVersion') as number);
  const expected = Buffer.from(`${baseline}${appended}`, 'utf8');
  expect(await readFile(target)).toEqual(expected);
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const journal = path.join(dataDir, 'featherpad-state', 'save-transactions');
  const receipts: string[] = [];
  for (const entry of await readdir(journal, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(journal, entry.name);
    const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Reflect.get(manifest, 'bodySha256') !== sha256) continue;
    expect(Reflect.get(manifest, 'documentVersion')).toBe(version);
    const actualTarget: unknown = Reflect.get(manifest, 'target');
    if (typeof actualTarget !== 'string') throw new Error('Native receipt target missing');
    expect(await realpath(actualTarget)).toBe(await realpath(target));
    expect(await readFile(path.join(directory, 'body.bin'))).toEqual(expected);
    const stage: unknown = JSON.parse(await readFile(path.join(directory, 'committed.json'), 'utf8'));
    expect(stage).toMatchObject({ receiptId: entry.name, stage: 'committed' });
    receipts.push(entry.name);
  }
  expect(receipts).toHaveLength(1);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(child.kill()).toBe(true); // Windows terminates only this test-owned spawn handle.
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5_000 }).toBe(true);
  expect(child.exitCode === 0).toBe(false);
  expect(await readFile(target)).toEqual(expected);
  expect(await readFile(path.join(journal, receipts[0]!, 'body.bin'))).toEqual(expected);
  expect(JSON.parse(await readFile(path.join(journal, receipts[0]!, 'committed.json'), 'utf8'))).toMatchObject({ stage: 'committed' });
  return { scope: 'Real Tauri child termination after durable commit before Ack delivery; not startup recovery or power loss',
    sourceSha256: sha256, receiptId: receipts[0], ackDelivered: false, exitCode: child.exitCode, signal: child.signalCode };
}

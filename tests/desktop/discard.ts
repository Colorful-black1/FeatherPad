import { expect, type Page } from '@playwright/test';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

interface DraftReceipt { receipt: string; documentId: string }

export async function verifyNativeDiscard(page: Page, dataDir: string, discarded: DraftReceipt, retained: DraftReceipt) {
  const recovery = path.join(dataDir, 'featherpad-state', 'recovery');
  const selected = JSON.parse(await readFile(path.join(recovery, discarded.receipt, 'manifest.json'), 'utf8')) as {
    documentId: string; bufferVersion: number;
  };
  expect(selected.documentId).toBe(discarded.documentId);
  const before = await readFile(path.join(recovery, discarded.receipt, 'body.bin'));
  const peerBefore = await readFile(path.join(recovery, retained.receipt, 'body.bin'));
  const receiptNames = [];
  for (const receipt of await readdir(recovery)) {
    if (!/^[0-9a-f-]{36}$/.test(receipt)) continue;
    const manifest = JSON.parse(await readFile(path.join(recovery, receipt, 'manifest.json'), 'utf8')) as {
      documentId: string; bufferVersion: number;
    };
    if (manifest.documentId === selected.documentId && manifest.bufferVersion <= selected.bufferVersion) receiptNames.push(receipt);
  }
  expect(receiptNames).toContain(discarded.receipt);
  const request = { documentId: selected.documentId, throughVersion: selected.bufferVersion };
  const rejected = await page.evaluate(async request => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    const pathField = await native.invoke('discard_recovery', { ...request, path: 'not accepted' });
    const unsafeVersion = await native.invoke('discard_recovery', { ...request, throughVersion: Number.MAX_SAFE_INTEGER + 1 });
    const invalidId = await native.invoke('discard_recovery', { ...request, documentId: '../outside' });
    return { pathField, unsafeVersion, invalidId };
  }, request);
  for (const result of Object.values(rejected)) expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await readFile(path.join(recovery, discarded.receipt, 'body.bin'))).toEqual(before);
  const results = await page.evaluate(async request => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    const sourceBefore = await native.invoke('stat_document', { documentId: request.documentId });
    const first = await native.invoke('discard_recovery', request);
    const repeated = await native.invoke('discard_recovery', request);
    const sourceAfter = await native.invoke('stat_document', { documentId: request.documentId });
    return { first, repeated, sourceBefore, sourceAfter };
  }, request);
  expect(results.first).toEqual({ ok: true, value: { ...request, discarded: true } });
  expect(results.repeated).toEqual(results.first);
  expect(results.sourceBefore).toMatchObject({ ok: true });
  expect(results.sourceAfter).toEqual(results.sourceBefore);
  for (const receipt of receiptNames) {
    expect(await stat(path.join(recovery, receipt)).then(() => true, () => false)).toBe(false);
  }
  expect(await readFile(path.join(recovery, retained.receipt, 'body.bin'))).toEqual(peerBefore);
  const marker = JSON.parse(await readFile(path.join(recovery, `discarded-${request.documentId}`, `${request.throughVersion}.json`), 'utf8')) as unknown;
  expect(marker).toEqual({ schemaVersion: 1, ...request });
  return { nativeDiscardValidated: true, nativeDiscardRemovesOnlyMatchingDrafts: true,
    nativeDiscardIdempotentAndSourceLeasePreserved: true, discardedDraftReceipts: receiptNames,
    discardScope: 'direct real Release IPC; selected before-trash fixture drafts explicitly discarded after their T105 checks; another draft retained; no close UI or startup recovery claim' };
}

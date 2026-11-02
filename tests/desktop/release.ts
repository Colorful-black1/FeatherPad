import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OpenDocument, ResultEnvelope } from '../../src/shared/contracts/files';

export async function verifyNativeRelease(page: Page, root: string, grant: { grantId: string; relativePath: string }) {
  const name = `release-${randomUUID()}.txt`;
  const largeName = `release-large-${randomUUID()}.txt`;
  const original = '原生关闭不改源😀\r\n';
  await writeFile(path.join(root, name), original, 'utf8');
  await writeFile(path.join(root, largeName), Buffer.alloc(20 * 1024 * 1024, 'a'));
  const result = await page.evaluate(async ({ grant, name, largeName }) => {
    const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
      invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    async function open(ref: { grantId: string; relativePath: string }): Promise<OpenDocument> {
      const result = await native.invoke('open_document', { ref }) as ResultEnvelope<OpenDocument>;
      if (!result.ok) throw new Error(`Native release fixture failed to open: ${result.error.code}`);
      return result.value;
    }
    const reference = { ...grant, relativePath: name };
    const document = await open(reference);
    const malformed = await native.invoke('release_document', { documentId: document.documentId, path: name });
    const invalid = await native.invoke('release_document', { documentId: '../outside' });
    const stillOpen = await native.invoke('stat_document', { documentId: document.documentId });
    const largeRef = { ...grant, relativePath: largeName };
    const first = await open(largeRef);
    const second = await open(largeRef);
    const released = await native.invoke('release_document', { documentId: document.documentId });
    const repeated = await native.invoke('release_document', { documentId: document.documentId });
    const closedStat = await native.invoke('stat_document', { documentId: document.documentId });
    const otherStat = await native.invoke('stat_document', { documentId: first.documentId });
    const reopened = await open(reference);
    const chunkRelease = await native.invoke('release_document', { documentId: first.documentId });
    const chunkReopened = await open(largeRef);
    if (chunkReopened.content.kind !== 'chunked') throw new Error('Expected reopened native chunk handle');
    const newChunk = await native.invoke('read_document_chunk', {
      documentId: chunkReopened.documentId, handleId: chunkReopened.content.handleId,
      expectedDiskRevision: chunkReopened.metadata.diskRevision, byteOffset: 0, maxBytes: 32,
    });
    const revoked = [];
    for (const document of [first, second]) {
      if (document.content.kind !== 'chunked') throw new Error('Expected native chunk handle');
      revoked.push(await native.invoke('read_document_chunk', {
        documentId: chunkReopened.documentId, handleId: document.content.handleId,
        expectedDiskRevision: chunkReopened.metadata.diskRevision, byteOffset: 0, maxBytes: 32,
      }));
    }
    const unknown = await native.invoke('release_document', { documentId: crypto.randomUUID() });
    for (const id of [reopened.documentId, chunkReopened.documentId]) {
      await native.invoke('release_document', { documentId: id });
    }
    return { malformed, invalid, stillOpen, released, repeated, closedStat, otherStat, chunkRelease,
      revoked, unknown, newChunk, initialId: document.documentId, reopenedId: reopened.documentId,
      chunkInitialId: first.documentId, chunkReopenedId: chunkReopened.documentId };
  }, { grant, name, largeName });
  expect(result.malformed).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(result.invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(result.stillOpen).toMatchObject({ ok: true });
  expect(result.released).toEqual({ ok: true, value: { released: true } });
  expect(result.repeated).toEqual({ ok: true, value: { released: false } });
  expect(result.unknown).toEqual({ ok: true, value: { released: false } });
  expect(result.closedStat).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(result.otherStat).toMatchObject({ ok: true });
  expect(result.chunkRelease).toEqual({ ok: true, value: { released: true } });
  for (const revoked of result.revoked) expect(revoked).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(result.newChunk).toMatchObject({ ok: true, value: { text: 'a'.repeat(32) } });
  expect(result.initialId).not.toBe(result.reopenedId);
  expect(result.chunkInitialId).not.toBe(result.chunkReopenedId);
  expect(await readFile(path.join(root, name), 'utf8')).toBe(original);
  return { nativeReleaseValidated: true, nativeReleasePreservesOtherDocumentAndSource: true,
    nativeReleaseRevokesAllChunks: true, nativeReleaseReopensWithNewId: true };
}

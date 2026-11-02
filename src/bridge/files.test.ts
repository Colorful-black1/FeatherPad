import { expect, it, vi } from 'vitest';
import type { DocumentId } from '../shared/contracts/files';
import { files, isChosenFiles, isChosenFolder, isDirectoryPage, isDiscardRecoveryResult, isFileRef, isOpenDocument, isReleaseDocumentResult, isRenameEntryResult, isSaveAck, isSaveAsAck, isTextChunk, isTrashImpact, isTrashEntryResult } from './files';

const valid = {
  documentId: 'document-fixture', ref: { grantId: 'fixture-grant', relativePath: '' },
  metadata: { displayPath: 'fixture.txt', sizeBytes: 3, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'fixture-revision' },
  format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
  content: { kind: 'text', text: 'a\nb', newlineMap: { documentVersion: 0, endings: ['lf'] } },
};

it('accepts released and already-unleased results but rejects an ambiguous release receipt', () => {
  expect(isReleaseDocumentResult({ released: true })).toBe(true);
  expect(isReleaseDocumentResult({ released: false })).toBe(true);
  for (const value of [null, {}, { released: 'true' }, { released: null }, { released: 1 }]) {
    expect(isReleaseDocumentResult(value)).toBe(false);
  }
});

it('requires an explicit versioned discard receipt and rejects unsafe versions and false acknowledgements', () => {
  const receipt = { documentId: valid.documentId, throughVersion: 1, discarded: true };
  expect(isDiscardRecoveryResult(receipt)).toBe(true);
  for (const value of [null, {}, { ...receipt, documentId: '' }, { ...receipt, discarded: false },
    { ...receipt, throughVersion: -1 }, { ...receipt, throughVersion: 1.5 },
    { ...receipt, throughVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(isDiscardRecoveryResult(value)).toBe(false);
  }
});

it('never accepts a discard acknowledgement for a different document or version', async () => {
  const request = { documentId: valid.documentId as DocumentId, throughVersion: 2 };
  let reply = { ...request, discarded: true };
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    expect(command).toBe('discard_recovery');
    expect(args).toEqual(request);
    return { ok: true, value: reply };
  } } });
  try {
    expect((await files.discardRecovery(request)).ok).toBe(true);
    reply = { ...reply, throughVersion: 1 };
    expect(await files.discardRecovery(request)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
    reply = { ...reply, throughVersion: 2, documentId: 'another-document' as DocumentId };
    expect(await files.discardRecovery(request)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  } finally { vi.unstubAllGlobals(); }
});

it('rejects malformed or duplicate trash impacts and inconsistent missing-document receipts', () => {
  const document = { documentId: 'document-fixture', displayPath: 'file.txt', canSnapshot: true };
  const impact = { ref: { grantId: 'grant', relativePath: 'file.txt' }, displayPath: 'file.txt', kind: 'file',
    revision: 'a'.repeat(64), identity: 'b'.repeat(64), affectedDocuments: [document] };
  expect(isTrashImpact(impact)).toBe(true);
  expect(isTrashImpact({ ...impact, identity: '' })).toBe(false);
  expect(isTrashImpact({ ...impact, affectedDocuments: [document, document] })).toBe(false);
  expect(isTrashImpact({ ...impact, ref: { ...impact.ref, relativePath: '' } })).toBe(false);
  const result = { trashed: true, receiptId: 'receipt', missingDocumentIds: [document.documentId],
    drafts: [{ documentId: document.documentId, documentVersion: 2, receiptId: 'draft' }] };
  expect(isTrashEntryResult(result)).toBe(true);
  expect(isTrashEntryResult({ ...result, trashed: false })).toBe(false);
  expect(isTrashEntryResult({ ...result, missingDocumentIds: [] })).toBe(false);
  expect(isTrashEntryResult({ ...result, drafts: [...result.drafts, ...result.drafts] })).toBe(false);
});

it('validates individual selection failures without dropping successful grant references', () => {
  const failure = { selectionIndex: 1, error: { code: 'NOT_FOUND', message: 'Controlled missing selection', retryable: false } };
  expect(isChosenFiles({ grants: [valid.ref, valid.ref], failures: [failure] })).toBe(true);
  expect(isChosenFiles({ grants: [], failures: [] })).toBe(true);
  expect(isChosenFiles({ grants: [valid.ref], failures: [{ ...failure, selectionIndex: -1 }] })).toBe(false);
  expect(isChosenFiles({ grants: [valid.ref], failures: [{ ...failure, selectionIndex: 2 }] })).toBe(false);
  expect(isChosenFiles({ grants: [valid.ref], failures: [failure, failure] })).toBe(false);
  expect(isChosenFiles({ grants: [valid.ref], failures: [{ ...failure, error: { code: 'UNKNOWN', message: 'bad', retryable: false } }] })).toBe(false);
  expect(isChosenFiles({ grants: [valid.ref] })).toBe(false);
});

it('validates complete directory pages and folder grants without trusting paths', () => {
  const folder = { grant: valid.ref, displayName: 'controlled-root' };
  const entry = {
    id: 'opaque-entry', ref: { grantId: valid.ref.grantId, relativePath: 'folder/file.txt' },
    name: 'file.txt', kind: 'file', isHidden: false, isReadOnly: false, revision: 'a'.repeat(64),
  };
  expect(isChosenFolder(folder)).toBe(true);
  expect(isChosenFolder({ grant: null, displayName: null })).toBe(true);
  expect(isChosenFolder({ grant: valid.ref, displayName: null })).toBe(false);
  expect(isDirectoryPage({ items: [entry], nextCursor: 'opaque-cursor' })).toBe(true);
  expect(isDirectoryPage({ items: [], nextCursor: null })).toBe(true);
  expect(isDirectoryPage({ items: [{ ...entry, kind: 'device' }], nextCursor: null })).toBe(false);
  expect(isDirectoryPage({ items: [{ ...entry, ref: { grantId: '', relativePath: '' } }], nextCursor: null })).toBe(false);
  expect(isDirectoryPage({ items: [], nextCursor: '' })).toBe(false);
  expect(isDirectoryPage({ items: [{ ...entry, revision: 'not-a-revision' }], nextCursor: null })).toBe(false);
});

it('validates rename results and their affected document mappings', () => {
  const entry = {
    id: 'renamed-entry', ref: { grantId: valid.ref.grantId, relativePath: 'renamed.txt' },
    name: 'renamed.txt', kind: 'file', isHidden: false, isReadOnly: false, revision: 'b'.repeat(64),
  };
  const result = {
    entry,
    renamedDocuments: [{
      documentId: valid.documentId, ref: entry.ref, displayPath: 'E:\\fixtures\\renamed.txt',
    }],
  };
  expect(isRenameEntryResult(result)).toBe(true);
  expect(isRenameEntryResult({ ...result, entry: { ...entry, revision: '' } })).toBe(false);
  expect(isRenameEntryResult({ ...result, renamedDocuments: [{ ...result.renamedDocuments[0], ref: null }] })).toBe(false);
});

it('accepts complete native text records and rejects damaged newline/metadata contracts', () => {
  expect(isOpenDocument(valid)).toBe(true);
  expect(isOpenDocument({ ...valid, content: { ...valid.content, newlineMap: { documentVersion: 0, endings: [] } } })).toBe(false);
  expect(isOpenDocument({ ...valid, metadata: { ...valid.metadata, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } })).toBe(false);
  expect(isOpenDocument({ ...valid, content: { ...valid.content, text: 'a\r\nb' } })).toBe(false);
  expect(isOpenDocument({ ...valid, format: { ...valid.format, bom: ['none'] } })).toBe(false);
  expect(isFileRef({ grantId: '', relativePath: '' })).toBe(false);
  expect(isFileRef({ grantId: 'opaque', relativePath: null })).toBe(false);
});

it('validates bounded chunk and explicitly truncated head-preview records', () => {
  const chunk = { byteStart: 0, byteEnd: 4, firstLine: 1, text: 'head', hasMore: true };
  const chunked = {
    ...valid, mode: 'large-readonly',
    content: { kind: 'chunked', handleId: 'chunk-handle', initialChunk: chunk, totalBytes: valid.metadata.sizeBytes },
  };
  const head = {
    ...valid, mode: 'head-preview',
    content: { kind: 'head', text: 'a\nb', previewBytes: 3, totalBytes: valid.metadata.sizeBytes, truncated: true },
  };
  expect(isTextChunk(chunk)).toBe(true);
  expect(isOpenDocument(chunked)).toBe(true);
  expect(isOpenDocument(head)).toBe(true);
  expect(isTextChunk({ ...chunk, byteEnd: -1 })).toBe(false);
  expect(isOpenDocument({ ...chunked, content: { ...chunked.content, totalBytes: 99 } })).toBe(false);
  expect(isOpenDocument({ ...head, content: { ...head.content, previewBytes: 99 } })).toBe(false);
  expect(isOpenDocument({ ...head, content: { ...head.content, truncated: false } })).toBe(false);
});

it('rejects damaged save acknowledgements instead of declaring a buffer saved', () => {
  const ack = { documentVersion: 2, diskRevision: 'opaque-revision', savedAt: '2026-11-01T00:00:00Z', sizeBytes: 12 };
  expect(isSaveAck(ack)).toBe(true);
  expect(isSaveAck({ ...ack, documentVersion: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  expect(isSaveAck({ ...ack, savedAt: 'invalid' })).toBe(false);
  expect(isSaveAck({ ...ack, sizeBytes: -1 })).toBe(false);
});

it('requires save-as metadata and Ack to describe the same saved bytes', () => {
  const result = { documentId: valid.documentId, ref: valid.ref, metadata: valid.metadata,
    ack: { documentVersion: 1, diskRevision: valid.metadata.diskRevision, sizeBytes: valid.metadata.sizeBytes, savedAt: valid.metadata.modifiedAt } };
  expect(isSaveAsAck(result)).toBe(true);
  expect(isSaveAsAck({ ...result, ack: { ...result.ack, diskRevision: 'different' } })).toBe(false);
  expect(isSaveAsAck({ ...result, ack: { ...result.ack, sizeBytes: 99 } })).toBe(false);
});

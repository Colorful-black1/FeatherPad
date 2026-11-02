import { expect, it, vi } from 'vitest';
import type { DiskRevision, DocumentId, FileRef, SessionManifest } from '../shared/contracts/files';
import { files, isChosenFiles, isChosenFolder, isDirectoryPage, isDiscardRecoveryResult, isFileRef, isLoadedRecoveryEntry, isOpenDocument, isRecoveryEntry, isRecoveryInventory, isRecoverySnapshotAck, isReleaseDocumentResult, isRenameEntryResult, isSaveAck, isSaveAsAck, isSessionLoadResult, isSessionManifest, isTextChunk, isTrashImpact, isTrashEntryResult } from './files';

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

it('accepts explicit full or truncated text previews but rejects inconsistent byte counts', () => {
  const preview = { ...valid, mode: 'text-preview', content: {
    kind: 'head', text: 'a␀b', previewBytes: 3, totalBytes: 3, truncated: false,
  } };
  expect(isOpenDocument(preview)).toBe(true);
  expect(isOpenDocument({ ...preview, content: { ...preview.content, truncated: true } })).toBe(false);
  const truncated = { ...preview, metadata: { ...valid.metadata, sizeBytes: 1024 * 1024 * 20 },
    content: { ...preview.content, totalBytes: 1024 * 1024 * 20, truncated: true } };
  expect(isOpenDocument(truncated)).toBe(true);
  expect(isOpenDocument({ ...truncated, content: { ...truncated.content, truncated: false } })).toBe(false);
  expect(isOpenDocument({ ...preview, content: { ...preview.content, previewBytes: 4 } })).toBe(false);
  expect(isOpenDocument({ ...preview, content: { ...preview.content, text: 'a\rb' } })).toBe(false);
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

it('validates recovery receipts and binds acknowledgements to the captured document version', async () => {
  const documentId = '3f037373-b9fd-4f03-8b25-5f316b91f764' as DocumentId;
  const receiptId = 'f4fe3fb6-a399-4b49-a754-10732a4350c4';
  const request = {
    documentId, documentVersion: 7, reason: 'periodic' as const, text: 'draft',
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' } as const,
  };
  const ack = {
    documentId, durableVersion: 7, receiptId, writtenAt: '2026-11-02T00:00:00.000000000Z',
  };
  expect(isRecoverySnapshotAck(ack)).toBe(true);
  for (const value of [
    null, {}, { ...ack, documentId: 'not-a-uuid' }, { ...ack, receiptId: 'receipt' },
    { ...ack, durableVersion: -1 }, { ...ack, durableVersion: 7.5 },
    { ...ack, durableVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...ack, writtenAt: 'invalid' },
  ]) expect(isRecoverySnapshotAck(value)).toBe(false);

  let reply = ack;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    expect(command).toBe('write_recovery_snapshot');
    expect(args).toEqual(request);
    return { ok: true, value: reply };
  } } });
  try {
    expect((await files.writeRecoverySnapshot(request)).ok).toBe(true);
    reply = { ...ack, durableVersion: 6 };
    expect(await files.writeRecoverySnapshot(request)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
    reply = { ...ack, documentId: '3b5f8beb-93b5-4dc3-819d-7c53cfe5be02' as DocumentId };
    expect(await files.writeRecoverySnapshot(request)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  } finally { vi.unstubAllGlobals(); }
});

it('validates isolated recovery inventories and exact loaded body metadata', async () => {
  const entry = {
    receiptId: 'f4fe3fb6-a399-4b49-a754-10732a4350c4',
    reason: 'periodic',
    documentId: '3f037373-b9fd-4f03-8b25-5f316b91f764',
    bufferVersion: 7,
    sourcePath: null,
    sourceRevision: null,
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
    newlineMap: { documentVersion: 7, endings: ['lf'] },
    bodyBytes: 6,
    bodySha256: 'a'.repeat(64),
    createdAt: '2026-11-02T00:00:00.000000000Z',
  };
  const inventory = {
    entries: [entry],
    failures: [{ entryId: 'damaged-entry', message: '隔离的损坏副本' }],
    startupWarnings: ['一个保存事务候选已保留。'],
    storageBytes: 1024,
    saveTransactions: [],
  };
  const loaded = { entry, text: 'draft\n' };
  expect(isRecoveryEntry(entry)).toBe(true);
  expect(isRecoveryInventory(inventory)).toBe(true);
  expect(isRecoveryInventory({ ...inventory, startupWarnings: [null] })).toBe(false);
  expect(isRecoveryInventory({ ...inventory, storageBytes: -1 })).toBe(false);
  expect(isLoadedRecoveryEntry(loaded)).toBe(true);
  expect(isRecoveryEntry({ ...entry, receiptId: 'receipt' })).toBe(false);
  expect(isRecoveryEntry({ ...entry, sourceRevision: 'a'.repeat(64) })).toBe(false);
  expect(isRecoveryEntry({ ...entry, newlineMap: { documentVersion: 6, endings: ['lf'] } })).toBe(false);
  expect(isLoadedRecoveryEntry({ ...loaded, text: 'draft\nmore' })).toBe(false);
  expect(isLoadedRecoveryEntry({ ...loaded, entry: { ...entry, newlineMap: { documentVersion: 7, endings: [] } } })).toBe(false);

  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    if (command === 'list_recovery_entries') {
      expect(args).toEqual({});
      return { ok: true, value: inventory };
    }
    expect(command).toBe('load_recovery_entry');
    expect(args).toEqual({ receiptId: entry.receiptId });
    return { ok: true, value: loaded };
  } } });
  try {
    expect((await files.listRecoveryEntries()).ok).toBe(true);
    expect((await files.loadRecoveryEntry({ receiptId: entry.receiptId })).ok).toBe(true);
    expect(await files.loadRecoveryEntry({ receiptId: '8dd90f06-92b9-4ff7-8dd6-1ad0a2e36a60' }))
      .toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  } finally { vi.unstubAllGlobals(); }
});

it('validates cross-referenced session manifests and binds save acknowledgements', async () => {
  const documentId = '3f037373-b9fd-4f03-8b25-5f316b91f764' as DocumentId;
  const receiptId = 'f4fe3fb6-a399-4b49-a754-10732a4350c4';
  const session: SessionManifest = {
    schemaVersion: 1,
    sessionId: '4947f96e-d4ab-442c-900f-b6ccca515d46',
    windows: [{
      windowId: 'main',
      bounds: { x: 20, y: 30, width: 1200, height: 800 },
      rootIds: ['4947f96e-d4ab-442c-900f-b6ccca515d47'],
      rootLabels: ['受控目录'],
      activeViewId: documentId,
      groups: [{ groupId: 'primary', viewIds: [documentId] }],
      views: [{
        viewId: documentId,
        bufferVersion: 7,
        documentId,
        recoveryReceiptId: receiptId,
        fileRef: { grantId: 'fixture-grant' as FileRef['grantId'], relativePath: '' },
        diskRevision: 'a'.repeat(64) as DiskRevision,
        openMode: 'normal',
        title: '草稿.txt',
        displayPath: 'E:\\fixtures\\草稿.txt',
        isPreview: false,
        dirty: true,
        selection: [{ anchor: 2, head: 5 }],
        scrollAnchor: 128.5,
      }],
    }],
    recoverySnapshotRefs: [receiptId],
    persistedAt: '2026-11-02T00:00:00.000000000Z',
  };
  expect(isSessionManifest(session)).toBe(true);
  expect(isSessionLoadResult({ session, warning: null, restoredGrantIds: [] })).toBe(true);
  expect(isSessionLoadResult({ session: null, warning: '损坏清单已隔离', restoredGrantIds: [] })).toBe(true);
  expect(isSessionLoadResult({ session, warning: null })).toBe(false);
  expect(isSessionManifest({ ...session, recoverySnapshotRefs: [] })).toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0],
    views: [{ ...session.windows[0]!.views[0]!, bufferVersion: Number.MAX_SAFE_INTEGER + 1 }] }] }))
    .toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0], groups: [] }] })).toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0],
    views: [{ ...session.windows[0]!.views[0]!, selection: [{ anchor: 2, head: Number.MAX_SAFE_INTEGER + 1 }] }] }] }))
    .toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0],
    views: [{ ...session.windows[0]!.views[0]!, fileRef: { grantId: '', relativePath: '' } }] }] }))
    .toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0],
    views: [{ ...session.windows[0]!.views[0]!, diskRevision: null }] }] }))
    .toBe(false);
  expect(isSessionManifest({ ...session, windows: [{ ...session.windows[0],
    views: [{ ...session.windows[0]!.views[0]!, fileRef: null }] }] }))
    .toBe(false);

  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    if (command === 'save_session') {
      expect(args).toEqual({ manifest: session });
      return { ok: true, value: { saved: true, persistedAt: session.persistedAt } };
    }
    if (command === 'load_session') {
      expect(args).toEqual({});
      return { ok: true, value: { session, warning: null, restoredGrantIds: [] } };
    }
    expect(command).toBe('clear_session');
    expect(args).toEqual({});
    return { ok: true, value: { cleared: true } };
  } } });
  try {
    expect((await files.saveSession(session)).ok).toBe(true);
    expect((await files.loadSession()).ok).toBe(true);
    expect((await files.clearSession()).ok).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it('reads a transaction copy only with a matching receipt and complete newline intent', async () => {
  const receiptId = crypto.randomUUID();
  const loaded = {
    receiptId, displayName: 'draft.txt', text: '草稿\n😀',
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
    newlineMap: { documentVersion: 1, endings: ['crlf'] },
  };
  let reply: unknown = loaded;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
    expect(command).toBe('load_save_transaction');
    expect(args).toEqual({ receiptId });
    return { ok: true, value: reply };
  } } });
  try {
    expect(await files.loadSaveTransaction({ receiptId })).toEqual({ ok: true, value: loaded });
    reply = { ...loaded, receiptId: crypto.randomUUID() };
    expect(await files.loadSaveTransaction({ receiptId })).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
    reply = { ...loaded, newlineMap: { documentVersion: 0, endings: ['crlf'] } };
    expect((await files.loadSaveTransaction({ receiptId })).ok).toBe(false);
    reply = { ...loaded, newlineMap: { documentVersion: 1, endings: [] } };
    expect((await files.loadSaveTransaction({ receiptId })).ok).toBe(false);
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

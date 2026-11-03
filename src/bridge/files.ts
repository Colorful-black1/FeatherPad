import type { ResourceImage } from '../shared/contracts/files';
import type { ChosenFiles, ChosenFolder, CreateEntryRequest, DirectoryEntry, DirectoryPage, DiscardRecoveryRequest, DiscardRecoveryResult, DocumentId, FileRef, ListDirectoryRequest, LoadedRecoveryEntry, LoadRecoveryEntryRequest, LoadSessionRequest, OpenDocument, ReadChunkRequest, RecoveryEntry, RecoveryInventory, RecoverySnapshotAck, ReleaseDocumentResult, RenameEntryRequest, RenameEntryResult, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest, SessionClearResult, SessionLoadResult, SessionManifest, SessionSaveResult, TextChunk, TextFormat, TransferEntryRequest, TransferEntryResult, TrashEntryRequest, TrashEntryResult, TrashImpact, TrashImpactRequest, WriteRecoverySnapshotRequest } from '../shared/contracts/files';
import { callCommand, isAppError, isRecord } from './invoke';
import type { LoadedSaveTransaction, SaveTransactionCandidate } from '../shared/contracts/files';
import type { OpenMode } from '../shared/contracts/files';
import { encodingIds, type EncodingId } from '../shared/contracts/encoding';

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const opaqueId = (value: unknown): value is string => nonemptyString(value) && value.length <= 128;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function isResourceImage(value: unknown): value is ResourceImage {
  if (!isRecord(value) || typeof value.mime !== 'string'
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(value.mime)
    || typeof value.dataBase64 !== 'string' || value.dataBase64.length > 28 * 1024 * 1024 || value.dataBase64.length % 4 !== 0
    || !/^[a-z\d+/]*={0,2}$/i.test(value.dataBase64)
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes <= 0 || value.sizeBytes > 20 * 1024 * 1024) return false;
  const decodedLength = value.dataBase64.length / 4 * 3 - (value.dataBase64.endsWith('==') ? 2 : value.dataBase64.endsWith('=') ? 1 : 0);
  if (decodedLength !== value.sizeBytes) return false;
  if (value.mime === 'image/svg+xml') return value.width === null && value.height === null;
  return typeof value.width === 'number' && Number.isSafeInteger(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isSafeInteger(value.height) && value.height > 0
    && value.width * value.height <= 40_000_000;
}

function isSelectionFailure(value: unknown): value is ChosenFiles['failures'][number] {
  return isRecord(value) && safeCount(value.selectionIndex) && isAppError(value.error);
}

function isTextFormat(value: unknown): value is TextFormat {
  return isRecord(value) && nonemptyString(value.encoding)
    && typeof value.bom === 'string' && ['none', 'utf8', 'utf16le', 'utf16be'].includes(value.bom)
    && typeof value.lineEnding === 'string' && ['lf', 'crlf', 'mixed'].includes(value.lineEnding);
}

function isNewlineMap(value: unknown): value is Exclude<RecoveryEntry['newlineMap'], null> {
  return isRecord(value) && safeCount(value.documentVersion) && Array.isArray(value.endings)
    && value.endings.every(ending => ending === 'lf' || ending === 'crlf' || ending === 'cr');
}

export function isChosenFiles(value: unknown): value is ChosenFiles {
  if (!isRecord(value) || !Array.isArray(value.grants) || !value.grants.every(isFileRef)
    || !Array.isArray(value.failures) || !value.failures.every(isSelectionFailure)) return false;
  const count = value.grants.length + value.failures.length;
  return value.failures.every(failure => failure.selectionIndex < count)
    && new Set(value.failures.map(failure => failure.selectionIndex)).size === value.failures.length;
}

export function isFileMetadata(value: unknown): value is OpenDocument['metadata'] {
  return isRecord(value) && nonemptyString(value.displayPath) && safeCount(value.sizeBytes)
    && nonemptyString(value.modifiedAt) && Number.isFinite(Date.parse(value.modifiedAt))
    && typeof value.isReadOnly === 'boolean' && nonemptyString(value.diskRevision);
}

export function isSaveAck(value: unknown): value is SaveAck {
  return isRecord(value) && safeCount(value.documentVersion) && safeCount(value.sizeBytes)
    && nonemptyString(value.diskRevision) && nonemptyString(value.savedAt) && Number.isFinite(Date.parse(value.savedAt));
}

export function isSaveAsAck(value: unknown): value is SaveAsAck {
  return isRecord(value) && nonemptyString(value.documentId) && isFileRef(value.ref)
    && isFileMetadata(value.metadata) && isSaveAck(value.ack)
    && value.metadata.diskRevision === value.ack.diskRevision && value.metadata.sizeBytes === value.ack.sizeBytes;
}

export function isFileRef(value: unknown): value is FileRef {
  return isRecord(value) && nonemptyString(value.grantId) && value.grantId.length <= 128
    && typeof value.relativePath === 'string' && value.relativePath.length <= 32_767;
}

export function isChosenFolder(value: unknown): value is ChosenFolder {
  return isRecord(value)
    && (value.grant === null || isFileRef(value.grant))
    && (value.displayName === null
      || (nonemptyString(value.displayName) && value.displayName.length <= 32_767))
    && ((value.grant === null) === (value.displayName === null));
}

export function isDirectoryEntry(value: unknown): value is DirectoryEntry {
  return isRecord(value) && nonemptyString(value.id) && value.id.length <= 128
    && isFileRef(value.ref) && nonemptyString(value.name) && value.name.length <= 32_767
    && ['file', 'directory', 'symlink', 'junction'].includes(value.kind as string)
    && typeof value.isHidden === 'boolean' && typeof value.isReadOnly === 'boolean'
    && typeof value.revision === 'string' && /^[0-9a-f]{64}$/i.test(value.revision);
}

export function isDirectoryPage(value: unknown): value is DirectoryPage {
  return isRecord(value) && Array.isArray(value.items) && value.items.length <= 1000
    && value.items.every(isDirectoryEntry)
    && (value.nextCursor === null
      || (nonemptyString(value.nextCursor) && value.nextCursor.length <= 128));
}

export function isRenameEntryResult(value: unknown): value is RenameEntryResult {
  return isRecord(value) && isDirectoryEntry(value.entry) && Array.isArray(value.renamedDocuments)
    && value.renamedDocuments.length <= 1000
    && value.renamedDocuments.every(document => isRecord(document)
      && nonemptyString(document.documentId) && document.documentId.length <= 128
      && isFileRef(document.ref) && nonemptyString(document.displayPath)
      && document.displayPath.length <= 32_767);
}

export function isTransferEntryResult(value: unknown): value is TransferEntryResult {
  return isRecord(value) && isDirectoryEntry(value.entry)
    && Array.isArray(value.renamedDocuments) && value.renamedDocuments.length <= 1000
    && value.renamedDocuments.every(document => isRecord(document)
      && nonemptyString(document.documentId) && document.documentId.length <= 128
      && isFileRef(document.ref) && nonemptyString(document.displayPath)
      && document.displayPath.length <= 32_767)
    && (value.mode === 'move' || value.mode === 'copy')
    && typeof value.sourceRemoved === 'boolean'
    && value.sourceRemoved === (value.mode === 'move');
}

export function isTrashImpact(value: unknown): value is TrashImpact {
  if (!isRecord(value) || !isFileRef(value.ref) || !value.ref.relativePath
    || !nonemptyString(value.displayPath) || value.displayPath.length > 32_767
    || !['file', 'directory'].includes(value.kind as string) || !revision(value.revision) || !revision(value.identity)
    || !Array.isArray(value.affectedDocuments) || value.affectedDocuments.length > 1000) return false;
  const ids = new Set<string>();
  return value.affectedDocuments.every(document => {
    if (!isRecord(document) || !opaqueId(document.documentId) || ids.has(document.documentId)
      || !nonemptyString(document.displayPath) || document.displayPath.length > 32_767
      || typeof document.canSnapshot !== 'boolean') return false;
    ids.add(document.documentId);
    return true;
  });
}

export function isTrashEntryResult(value: unknown): value is TrashEntryResult {
  if (!isRecord(value) || value.trashed !== true || !opaqueId(value.receiptId)
    || !Array.isArray(value.missingDocumentIds) || value.missingDocumentIds.length > 1000
    || !value.missingDocumentIds.every(opaqueId) || new Set(value.missingDocumentIds).size !== value.missingDocumentIds.length
    || !Array.isArray(value.drafts) || value.drafts.length > 1000) return false;
  const missingDocumentIds = value.missingDocumentIds;
  const ids = new Set<string>();
  return value.drafts.every(draft => {
    if (!isRecord(draft) || !opaqueId(draft.documentId) || !safeCount(draft.documentVersion)
      || !opaqueId(draft.receiptId) || !missingDocumentIds.includes(draft.documentId) || ids.has(draft.documentId)) return false;
    ids.add(draft.documentId);
    return true;
  });
}

export function isOpenDocument(value: unknown): value is OpenDocument {
  if (!isRecord(value) || !nonemptyString(value.documentId) || !isFileRef(value.ref)
    || !isRecord(value.metadata) || !isRecord(value.format) || !isRecord(value.content)
    || (value.canonicalIdentity !== undefined
      && (typeof value.canonicalIdentity !== 'string' || value.canonicalIdentity.length > 128))) return false;
  const { metadata, format, content } = value;
  if (!isFileMetadata(metadata)) return false;
  if (!nonemptyString(format.encoding) || typeof format.bom !== 'string'
    || !['none', 'utf8', 'utf16le', 'utf16be'].includes(format.bom)
    || typeof format.lineEnding !== 'string' || !['lf', 'crlf', 'mixed'].includes(format.lineEnding)) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) return false;
  if ((value.mode === 'normal' || value.mode === 'degraded') && content.kind === 'text') {
    if (typeof content.text !== 'string' || content.text.includes('\r')
      || !isRecord(content.newlineMap) || !safeCount(content.newlineMap.documentVersion)
      || !Array.isArray(content.newlineMap.endings)
      || !content.newlineMap.endings.every(ending => ending === 'lf' || ending === 'crlf' || ending === 'cr')) return false;
    let newlineCount = 0;
    for (let i = 0; i < content.text.length; i++) if (content.text.charCodeAt(i) === 10) newlineCount++;
    return content.newlineMap.endings.length === newlineCount;
  }
  if (value.mode === 'image-readonly' && content.kind === 'image') return isResourceImage(content.image)
    && content.image.sizeBytes === metadata.sizeBytes && format.encoding === 'binary' && format.bom === 'none';
  if (value.mode === 'large-readonly' && content.kind === 'chunked') {
    return nonemptyString(content.handleId) && safeCount(content.totalBytes)
      && content.totalBytes === metadata.sizeBytes && isTextChunk(content.initialChunk);
  }
  if ((value.mode === 'head-preview' || value.mode === 'text-preview') && content.kind === 'head') {
    return typeof content.text === 'string' && !content.text.includes('\r')
      && safeCount(content.previewBytes) && safeCount(content.totalBytes)
      && content.previewBytes <= content.totalBytes && content.totalBytes === metadata.sizeBytes
      && (value.mode === 'head-preview' ? content.truncated === true
        : typeof content.truncated === 'boolean' && content.truncated === (content.previewBytes < content.totalBytes));
  }
  return false;
}

export function isTextChunk(value: unknown): value is TextChunk {
  return isRecord(value) && safeCount(value.byteStart) && safeCount(value.byteEnd)
    && value.byteEnd >= value.byteStart && safeCount(value.firstLine) && value.firstLine >= 1
    && typeof value.text === 'string' && !value.text.includes('\r')
    && typeof value.hasMore === 'boolean';
}

export function isReleaseDocumentResult(value: unknown): value is ReleaseDocumentResult {
  return isRecord(value) && typeof value.released === 'boolean';
}

export function isDiscardRecoveryResult(value: unknown): value is DiscardRecoveryResult {
  return isRecord(value) && opaqueId(value.documentId) && safeCount(value.throughVersion) && value.discarded === true;
}

export function isRecoverySnapshotAck(value: unknown): value is RecoverySnapshotAck {
  return isRecord(value) && uuid(value.documentId) && safeCount(value.durableVersion)
    && uuid(value.receiptId) && typeof value.writtenAt === 'string'
    && Number.isFinite(Date.parse(value.writtenAt));
}

export function isRecoveryEntry(value: unknown): value is RecoveryEntry {
  return isRecord(value) && uuid(value.receiptId)
    && ['before-trash', 'periodic', 'hot-exit'].includes(value.reason as string)
    && uuid(value.documentId) && safeCount(value.bufferVersion)
    && (value.sourcePath === null
      || (nonemptyString(value.sourcePath) && value.sourcePath.length <= 32_767))
    && (value.sourceRevision === null
      || (typeof value.sourceRevision === 'string' && revision(value.sourceRevision)))
    && ((value.sourcePath === null) === (value.sourceRevision === null))
    && (value.reason !== 'before-trash' || value.sourcePath !== null)
    && isTextFormat(value.format)
    && (value.newlineMap === null || (isNewlineMap(value.newlineMap)
      && value.newlineMap.documentVersion === value.bufferVersion))
    && safeCount(value.bodyBytes) && typeof value.bodySha256 === 'string'
    && revision(value.bodySha256) && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt));
}

export function isRecoveryInventory(value: unknown): value is RecoveryInventory {
  return isRecord(value) && Array.isArray(value.entries) && value.entries.length <= 100_000
    && value.entries.every(isRecoveryEntry)
    && Array.isArray(value.failures) && value.failures.length <= 100_000
    && value.failures.every(failure => isRecord(failure)
      && nonemptyString(failure.entryId) && failure.entryId.length <= 128
      && nonemptyString(failure.message) && failure.message.length <= 4096)
    && Array.isArray(value.startupWarnings) && value.startupWarnings.length <= 100_000
    && value.startupWarnings.every(warning => nonemptyString(warning) && warning.length <= 4096)
    && safeCount(value.storageBytes)
    && Array.isArray(value.saveTransactions) && value.saveTransactions.length <= 100_000
    && value.saveTransactions.every(isSaveTransactionCandidate)
    && new Set(value.saveTransactions.map(candidate => candidate.receiptId)).size === value.saveTransactions.length;
}

function isSaveTransactionCandidate(value: unknown): value is SaveTransactionCandidate {
  return isRecord(value) && uuid(value.receiptId)
    && nonemptyString(value.displayName) && value.displayName.length <= 32_767
    && safeCount(value.bufferVersion) && safeCount(value.bodyBytes) && value.bodyBytes <= 100 * 1024 * 1024;
}

export function isLoadedSaveTransaction(value: unknown): value is LoadedSaveTransaction {
  if (!isRecord(value) || !uuid(value.receiptId)
    || !nonemptyString(value.displayName) || value.displayName.length > 32_767
    || typeof value.text !== 'string' || value.text.includes('\r')
    || !isTextFormat(value.format) || !isNewlineMap(value.newlineMap)
    || value.newlineMap.documentVersion !== 1) return false;
  let count = 0;
  for (let index = 0; index < value.text.length; index++) {
    if (value.text.charCodeAt(index) === 10) count++;
  }
  return value.newlineMap.endings.length === count;
}

export function isLoadedRecoveryEntry(value: unknown): value is LoadedRecoveryEntry {
  if (!isRecord(value) || !isRecoveryEntry(value.entry) || typeof value.text !== 'string'
    || value.text.includes('\r') || new TextEncoder().encode(value.text).byteLength !== value.entry.bodyBytes) return false;
  if (value.entry.newlineMap === null) return true;
  let newlineCount = 0;
  for (let index = 0; index < value.text.length; index++) {
    if (value.text.charCodeAt(index) === 10) newlineCount++;
  }
  return value.entry.newlineMap.endings.length === newlineCount;
}

export function isSessionManifest(value: unknown): value is SessionManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !uuid(value.sessionId)
    || !Array.isArray(value.windows) || value.windows.length > 32
    || !Array.isArray(value.recoverySnapshotRefs) || value.recoverySnapshotRefs.length > 1000
    || !value.recoverySnapshotRefs.every(uuid)
    || new Set(value.recoverySnapshotRefs).size !== value.recoverySnapshotRefs.length
    || typeof value.persistedAt !== 'string' || !Number.isFinite(Date.parse(value.persistedAt))) return false;
  const refs = new Set(value.recoverySnapshotRefs);
  const referenced = new Set<string>();
  const windowIds = new Set<string>();
  for (const window of value.windows) {
    if (!isRecord(window) || !nonemptyString(window.windowId) || window.windowId.length > 128
      || windowIds.has(window.windowId) || !isRecord(window.bounds)
      || !Number.isSafeInteger(window.bounds.x) || Math.abs(window.bounds.x as number) > 1_000_000
      || !Number.isSafeInteger(window.bounds.y) || Math.abs(window.bounds.y as number) > 1_000_000
      || !safeCount(window.bounds.width) || window.bounds.width === 0 || window.bounds.width > 100_000
      || !safeCount(window.bounds.height) || window.bounds.height === 0 || window.bounds.height > 100_000
      || !Array.isArray(window.rootIds) || window.rootIds.length > 16
      || !Array.isArray(window.rootLabels) || window.rootLabels.length !== window.rootIds.length
      || !Array.isArray(window.views) || window.views.length > 1000
      || !Array.isArray(window.groups) || window.groups.length > 2
      || (window.activeViewId !== null && !nonemptyString(window.activeViewId))) return false;
    windowIds.add(window.windowId);
    const roots = new Set<string>();
    for (let index = 0; index < window.rootIds.length; index++) {
      const id = window.rootIds[index];
      const label = window.rootLabels[index];
      if (!nonemptyString(id) || id.length > 128 || roots.has(id)
        || !nonemptyString(label) || label.length > 32_767) return false;
      roots.add(id);
    }
    const viewIds = new Set<string>();
    for (const view of window.views) {
      if (!isRecord(view) || !uuid(view.viewId) || !uuid(view.documentId) || viewIds.has(view.viewId)
        || !safeCount(view.bufferVersion)
        || (view.recoveryReceiptId !== null && (!uuid(view.recoveryReceiptId) || !refs.has(view.recoveryReceiptId)))
        || (view.fileRef !== null && !isFileRef(view.fileRef))
        || (view.diskRevision !== null && (typeof view.diskRevision !== 'string' || !revision(view.diskRevision)))
        || ((view.fileRef === null) !== (view.diskRevision === null))
        || (view.openMode !== 'normal' && view.openMode !== 'head-preview' && view.openMode !== 'text-preview')
        || (view.encodingOverride !== undefined && !encodingIds.includes(view.encodingOverride as EncodingId))
        || !nonemptyString(view.title) || view.title.length > 32_767
        || (view.displayPath !== null && (!nonemptyString(view.displayPath) || view.displayPath.length > 32_767))
        || typeof view.isPreview !== 'boolean' || typeof view.dirty !== 'boolean'
        || !Array.isArray(view.selection) || view.selection.length === 0 || view.selection.length > 16
        || !view.selection.every(selection => isRecord(selection)
          && safeCount(selection.anchor) && safeCount(selection.head))
        || typeof view.scrollAnchor !== 'number' || !Number.isFinite(view.scrollAnchor)
        || view.scrollAnchor < 0 || view.scrollAnchor > 1_000_000_000_000) return false;
      viewIds.add(view.viewId);
      if (view.recoveryReceiptId !== null) referenced.add(view.recoveryReceiptId);
    }
    const grouped = new Set<string>();
    const groupIds = new Set<string>();
    for (const group of window.groups) {
      if (!isRecord(group) || (group.groupId !== 'primary' && group.groupId !== 'secondary')
        || groupIds.has(group.groupId) || !Array.isArray(group.viewIds)) return false;
      groupIds.add(group.groupId);
      for (const id of group.viewIds) {
        if (!nonemptyString(id) || !viewIds.has(id) || grouped.has(id)) return false;
        grouped.add(id);
      }
    }
    if (grouped.size !== viewIds.size || [...viewIds].some(id => !grouped.has(id))
      || (window.activeViewId !== null && !viewIds.has(window.activeViewId))) return false;
  }
  return referenced.size === refs.size && [...refs].every(receipt => referenced.has(receipt));
}

export function isSessionLoadResult(value: unknown): value is SessionLoadResult {
  return isRecord(value) && (value.session === null || isSessionManifest(value.session))
    && (value.warning === null || (typeof value.warning === 'string' && value.warning.length <= 4096))
    && Array.isArray(value.restoredGrantIds)
    && value.restoredGrantIds.every(id => nonemptyString(id) && id.length <= 128)
    && new Set(value.restoredGrantIds).size === value.restoredGrantIds.length;
}

export const files = {
  chooseFiles: (multiple = false) => callCommand('choose_files', { multiple }, isChosenFiles),
  chooseFolder: () => callCommand('choose_folder', {}, isChosenFolder),
  listDirectory: (request: ListDirectoryRequest) => callCommand('list_directory', { ...request }, isDirectoryPage),
  createEntry: (request: CreateEntryRequest) => callCommand('create_entry', { ...request }, isDirectoryEntry),
  renameEntry: (request: RenameEntryRequest) => callCommand('rename_entry', { ...request }, isRenameEntryResult),
  transferEntry: (request: TransferEntryRequest) =>
    callCommand('transfer_entry', { ...request }, (value): value is TransferEntryResult =>
      isTransferEntryResult(value) && value.entry.ref.relativePath
        .split('/').at(-1) === request.source.relativePath.split('/').at(-1)),
  trashImpact: (request: TrashImpactRequest) => callCommand('get_trash_impact', { ...request }, isTrashImpact),
  trashEntry: (request: TrashEntryRequest) => callCommand('trash_entry', { ...request }, isTrashEntryResult),
  open: (ref: FileRef, mode?: Exclude<OpenMode, 'normal'>, documentId?: DocumentId, encodingOverride?: string) => callCommand(
    'open_document',
    { ref, ...(mode ? { mode } : {}), ...(documentId ? { documentId } : {}), ...(encodingOverride ? { encodingOverride } : {}) },
    isOpenDocument,
  ),
  release: (documentId: DocumentId) => callCommand('release_document', { documentId }, isReleaseDocumentResult),
  discardRecovery: (request: DiscardRecoveryRequest) => callCommand('discard_recovery', { ...request },
    (value): value is DiscardRecoveryResult => isDiscardRecoveryResult(value)
      && value.documentId === request.documentId && value.throughVersion === request.throughVersion),
  writeRecoverySnapshot: (request: WriteRecoverySnapshotRequest) =>
    callCommand('write_recovery_snapshot', { ...request },
      (value): value is RecoverySnapshotAck => isRecoverySnapshotAck(value)
        && value.documentId === request.documentId
        && value.durableVersion === request.documentVersion),
  listRecoveryEntries: () => callCommand('list_recovery_entries', {}, isRecoveryInventory),
  loadSaveTransaction: (request: LoadRecoveryEntryRequest) =>
    callCommand('load_save_transaction', { ...request },
      (value): value is LoadedSaveTransaction => isLoadedSaveTransaction(value)
        && value.receiptId === request.receiptId),
  loadRecoveryEntry: (request: LoadRecoveryEntryRequest) =>
    callCommand('load_recovery_entry', { ...request },
      (value): value is LoadedRecoveryEntry => isLoadedRecoveryEntry(value)
        && value.entry.receiptId === request.receiptId),
  saveSession: (manifest: SessionManifest) => callCommand('save_session', { manifest },
    (value): value is SessionSaveResult => isRecord(value) && value.saved === true
      && typeof value.persistedAt === 'string' && value.persistedAt === manifest.persistedAt),
  loadSession: (request: LoadSessionRequest = {}) => callCommand('load_session', { ...request,
    ...(request.restoreGrantIds ? { restoreGrantIds: [...new Set(request.restoreGrantIds)] } : {}) }, isSessionLoadResult),
  clearSession: () => callCommand('clear_session', {},
    (value): value is SessionClearResult => isRecord(value) && value.cleared === true),
  readChunk: (request: ReadChunkRequest) => callCommand('read_document_chunk', { ...request }, isTextChunk),
  save: (request: SaveRequest) => callCommand('save_document', { ...request }, isSaveAck),
  autoSave: (request: SaveRequest) => callCommand('auto_save_document', { ...request }, isSaveAck),
  saveAs: (request: SaveAsRequest) => callCommand('save_document_as', { ...request }, isSaveAsAck),
  stat: (documentId: DocumentId) => callCommand('stat_document', { documentId }, isFileMetadata),
};

import type { ChosenFiles, ChosenFolder, CreateEntryRequest, DirectoryEntry, DirectoryPage, DocumentId, FileRef, ListDirectoryRequest, OpenDocument, ReadChunkRequest, ReleaseDocumentResult, RenameEntryRequest, RenameEntryResult, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest, TextChunk, TrashEntryRequest, TrashEntryResult, TrashImpact, TrashImpactRequest } from '../shared/contracts/files';
import { callCommand, isAppError, isRecord } from './invoke';

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const opaqueId = (value: unknown): value is string => nonemptyString(value) && value.length <= 128;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

function isSelectionFailure(value: unknown): value is ChosenFiles['failures'][number] {
  return isRecord(value) && safeCount(value.selectionIndex) && isAppError(value.error);
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
    || !isRecord(value.metadata) || !isRecord(value.format) || !isRecord(value.content)) return false;
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
  if (value.mode === 'large-readonly' && content.kind === 'chunked') {
    return nonemptyString(content.handleId) && safeCount(content.totalBytes)
      && content.totalBytes === metadata.sizeBytes && isTextChunk(content.initialChunk);
  }
  if (value.mode === 'head-preview' && content.kind === 'head') {
    return typeof content.text === 'string' && !content.text.includes('\r')
      && safeCount(content.previewBytes) && safeCount(content.totalBytes)
      && content.previewBytes <= content.totalBytes && content.totalBytes === metadata.sizeBytes
      && content.truncated === true;
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

export const files = {
  chooseFiles: (multiple = false) => callCommand('choose_files', { multiple }, isChosenFiles),
  chooseFolder: () => callCommand('choose_folder', {}, isChosenFolder),
  listDirectory: (request: ListDirectoryRequest) => callCommand('list_directory', { ...request }, isDirectoryPage),
  createEntry: (request: CreateEntryRequest) => callCommand('create_entry', { ...request }, isDirectoryEntry),
  renameEntry: (request: RenameEntryRequest) => callCommand('rename_entry', { ...request }, isRenameEntryResult),
  trashImpact: (request: TrashImpactRequest) => callCommand('get_trash_impact', { ...request }, isTrashImpact),
  trashEntry: (request: TrashEntryRequest) => callCommand('trash_entry', { ...request }, isTrashEntryResult),
  open: (ref: FileRef, mode?: 'head-preview') => callCommand('open_document', mode ? { ref, mode } : { ref }, isOpenDocument),
  release: (documentId: DocumentId) => callCommand('release_document', { documentId }, isReleaseDocumentResult),
  readChunk: (request: ReadChunkRequest) => callCommand('read_document_chunk', { ...request }, isTextChunk),
  save: (request: SaveRequest) => callCommand('save_document', { ...request }, isSaveAck),
  saveAs: (request: SaveAsRequest) => callCommand('save_document_as', { ...request }, isSaveAsAck),
  stat: (documentId: DocumentId) => callCommand('stat_document', { documentId }, isFileMetadata),
};

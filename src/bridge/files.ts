import type { ChosenFiles, DocumentId, FileRef, OpenDocument, ReadChunkRequest, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest, TextChunk } from '../shared/contracts/files';
import { callCommand, isAppError, isRecord } from './invoke';

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

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

export const files = {
  chooseFiles: (multiple = false) => callCommand('choose_files', { multiple }, isChosenFiles),
  chooseFolder: () => callCommand('choose_folder', {}, (value): value is { grant: FileRef | null } =>
    isRecord(value) && (value.grant === null || isFileRef(value.grant))),
  open: (ref: FileRef, mode?: 'head-preview') => callCommand('open_document', mode ? { ref, mode } : { ref }, isOpenDocument),
  readChunk: (request: ReadChunkRequest) => callCommand('read_document_chunk', { ...request }, isTextChunk),
  save: (request: SaveRequest) => callCommand('save_document', { ...request }, isSaveAck),
  saveAs: (request: SaveAsRequest) => callCommand('save_document_as', { ...request }, isSaveAsAck),
  stat: (documentId: DocumentId) => callCommand('stat_document', { documentId }, isFileMetadata),
};

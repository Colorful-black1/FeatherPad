import type { DocumentId, FileRef, OpenDocument, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest } from '../shared/contracts/files';
import { callCommand, isRecord } from './invoke';

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

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
  if (value.mode !== 'normal' && value.mode !== 'degraded') return false;
  if (!isFileMetadata(metadata)) return false;
  if (!nonemptyString(format.encoding) || typeof format.bom !== 'string'
    || !['none', 'utf8', 'utf16le', 'utf16be'].includes(format.bom)
    || typeof format.lineEnding !== 'string' || !['lf', 'crlf', 'mixed'].includes(format.lineEnding)) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) return false;
  if (content.kind !== 'text' || typeof content.text !== 'string' || content.text.includes('\r')
    || !isRecord(content.newlineMap) || !safeCount(content.newlineMap.documentVersion)
    || !Array.isArray(content.newlineMap.endings)
    || !content.newlineMap.endings.every(ending => ending === 'lf' || ending === 'crlf' || ending === 'cr')) return false;
  let newlineCount = 0;
  for (let i = 0; i < content.text.length; i++) if (content.text.charCodeAt(i) === 10) newlineCount++;
  return content.newlineMap.endings.length === newlineCount;
}

export const files = {
  chooseFiles: (multiple = false) => callCommand('choose_files', { multiple }, (value): value is { grants: FileRef[] } =>
    isRecord(value) && Array.isArray(value.grants) && value.grants.every(isFileRef)),
  chooseFolder: () => callCommand('choose_folder', {}, (value): value is { grant: FileRef | null } =>
    isRecord(value) && (value.grant === null || isFileRef(value.grant))),
  open: (ref: FileRef) => callCommand('open_document', { ref }, isOpenDocument),
  save: (request: SaveRequest) => callCommand('save_document', { ...request }, isSaveAck),
  saveAs: (request: SaveAsRequest) => callCommand('save_document_as', { ...request }, isSaveAsAck),
  stat: (documentId: DocumentId) => callCommand('stat_document', { documentId }, isFileMetadata),
};

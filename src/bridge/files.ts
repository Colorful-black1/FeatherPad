import type { FileRef, OpenDocument } from '../shared/contracts/files';
import { callCommand, isRecord } from './invoke';

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isFileRef(value: unknown): value is FileRef {
  return isRecord(value) && nonemptyString(value.grantId) && value.grantId.length <= 128
    && typeof value.relativePath === 'string' && value.relativePath.length <= 32_767;
}

export function isOpenDocument(value: unknown): value is OpenDocument {
  if (!isRecord(value) || !nonemptyString(value.documentId) || !isFileRef(value.ref)
    || !isRecord(value.metadata) || !isRecord(value.format) || !isRecord(value.content)) return false;
  const { metadata, format, content } = value;
  if (value.mode !== 'normal' && value.mode !== 'degraded') return false;
  if (!nonemptyString(metadata.displayPath) || !safeCount(metadata.sizeBytes)
    || !nonemptyString(metadata.modifiedAt) || !Number.isFinite(Date.parse(metadata.modifiedAt))
    || typeof metadata.isReadOnly !== 'boolean' || !nonemptyString(metadata.diskRevision)) return false;
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
};

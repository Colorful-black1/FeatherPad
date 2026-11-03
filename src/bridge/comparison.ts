import type { FileMetadata, FileRef, TextFormat } from '../shared/contracts/files';
import type { EncodingId } from '../shared/contracts/encoding';
import { isFileMetadata } from './files';
import { callCommand, isRecord } from './invoke';

export interface ComparisonSnapshot { text: string; metadata: FileMetadata; format: TextFormat }
function isComparisonSnapshot(value: unknown): value is ComparisonSnapshot {
  return isRecord(value) && typeof value.text === 'string' && !value.text.includes('\r') && value.text.length < 20 * 1024 * 1024
    && isFileMetadata(value.metadata) && value.metadata.sizeBytes < 20 * 1024 * 1024 && isRecord(value.format)
    && typeof value.format.encoding === 'string' && typeof value.format.bom === 'string' && ['none', 'utf8', 'utf16le', 'utf16be'].includes(value.format.bom)
    && typeof value.format.lineEnding === 'string' && ['lf', 'crlf', 'mixed'].includes(value.format.lineEnding);
}
export const comparisonBridge = {
  read: (ref: FileRef, encoding: EncodingId | null) => callCommand('read_comparison_snapshot', { ref, encoding }, isComparisonSnapshot),
};

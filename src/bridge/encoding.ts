import { encodingIds, type EncodingId, type EncodingInspection } from '../shared/contracts/encoding';
import type { DiskRevision, DocumentId } from '../shared/contracts/files';
import { isOpenDocument } from './files';
import { callCommand, isRecord } from './invoke';

export function isEncodingInspection(value: unknown): value is EncodingInspection {
  if (!isRecord(value) || !encodingIds.includes(value.encoding as EncodingId)
    || typeof value.documentVersion !== 'number' || !Number.isSafeInteger(value.documentVersion) || value.documentVersion < 0
    || typeof value.lossCount !== 'number' || !Number.isSafeInteger(value.lossCount) || value.lossCount < 0
    || !Array.isArray(value.samples) || value.samples.length !== Math.min(value.lossCount, 32)
    || (value.lossCount === 0 ? value.replacementText !== null
      : typeof value.replacementText !== 'string' || value.replacementText.includes('\r'))) return false;
  let end = -1;
  return value.samples.every(sample => {
    if (!isRecord(sample) || typeof sample.offset !== 'number' || !Number.isSafeInteger(sample.offset)
      || sample.offset < 0 || sample.offset < end || (sample.length !== 1 && sample.length !== 2)) return false;
    end = sample.offset + sample.length;
    return Number.isSafeInteger(end);
  });
}

export const encodings = {
  check: (text: string, encoding: EncodingId, documentVersion: number) => callCommand('check_encoding',
    { text, encoding, documentVersion }, (value): value is EncodingInspection => isEncodingInspection(value)
      && value.encoding === encoding && value.documentVersion === documentVersion
      && value.samples.every(sample => sample.offset + sample.length <= text.length)),
  reopen: (documentId: DocumentId, encoding: EncodingId, expectedDiskRevision: DiskRevision) => callCommand('reopen_with_encoding',
    { documentId, encoding, expectedDiskRevision }, (value): value is import('../shared/contracts/files').OpenDocument => isOpenDocument(value)
      && value.documentId === documentId && value.metadata.diskRevision === expectedDiskRevision && value.format.encoding === encoding),
};

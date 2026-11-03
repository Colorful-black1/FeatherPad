import { expect, it } from 'vitest';
import type { DocumentId, RecoveryEntry } from '../../shared/contracts/files';
import { inactiveRecoveryGroups } from './privacy';

const id = (suffix: string) => `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}` as DocumentId;
const entry = (documentId: DocumentId, version: number, bodyBytes: number): RecoveryEntry => ({
  receiptId: `${version}-${documentId}`, reason: 'periodic', documentId, bufferVersion: version,
  sourcePath: null, sourceRevision: null, format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
  newlineMap: null, bodyBytes, bodySha256: 'a'.repeat(64), createdAt: '2026-11-03T00:00:00Z',
});

it('groups only inactive recovery documents and keeps active dirty buffers protected', () => {
  const active = id('a');
  const inactive = id('b');
  expect(inactiveRecoveryGroups([
    entry(active, 1, 10), entry(active, 8, 20),
    entry(inactive, 3, 30), entry(inactive, 5, 50),
  ], new Set([active]))).toEqual([{
    documentId: inactive, throughVersion: 5, entries: 2, bodyBytes: 80,
  }]);
});

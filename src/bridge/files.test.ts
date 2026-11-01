import { expect, it } from 'vitest';
import { isFileRef, isOpenDocument, isSaveAck, isSaveAsAck } from './files';

const valid = {
  documentId: 'document-fixture', ref: { grantId: 'fixture-grant', relativePath: '' },
  metadata: { displayPath: 'fixture.txt', sizeBytes: 3, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'fixture-revision' },
  format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
  content: { kind: 'text', text: 'a\nb', newlineMap: { documentVersion: 0, endings: ['lf'] } },
};

it('accepts complete native text records and rejects damaged newline/metadata contracts', () => {
  expect(isOpenDocument(valid)).toBe(true);
  expect(isOpenDocument({ ...valid, content: { ...valid.content, newlineMap: { documentVersion: 0, endings: [] } } })).toBe(false);
  expect(isOpenDocument({ ...valid, metadata: { ...valid.metadata, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } })).toBe(false);
  expect(isOpenDocument({ ...valid, content: { ...valid.content, text: 'a\r\nb' } })).toBe(false);
  expect(isOpenDocument({ ...valid, format: { ...valid.format, bom: ['none'] } })).toBe(false);
  expect(isFileRef({ grantId: '', relativePath: '' })).toBe(false);
  expect(isFileRef({ grantId: 'opaque', relativePath: null })).toBe(false);
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

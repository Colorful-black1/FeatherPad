import { expect, it } from 'vitest';
import { isFileRef, isOpenDocument } from './files';

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

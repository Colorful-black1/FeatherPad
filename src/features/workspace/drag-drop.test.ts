import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileRef } from '../../shared/contracts/files';
import { canTransferEntry, dragPayload, parseDragPayload, transferConfirmation, transferMode } from './drag-drop';

const entry: DirectoryEntry = {
  id: 'source',
  ref: { grantId: 'grant', relativePath: 'folder/source.txt' } as DirectoryEntry['ref'],
  name: 'source.txt',
  kind: 'file',
  isHidden: false,
  isReadOnly: false,
  revision: 'a'.repeat(64),
};

const target = (relativePath: string, grantId = 'grant') =>
  ({ grantId, relativePath }) as FileRef;

describe('workspace drag payload', () => {
  it('round-trips only the validated revision and opaque reference', () => {
    expect(parseDragPayload(JSON.stringify(dragPayload(entry)))).toEqual(dragPayload(entry));
    expect(parseDragPayload('{"grantId":"grant","relativePath":"x","revision":"bad"}')).toBeNull();
    expect(parseDragPayload('not-json')).toBeNull();
  });

  it('uses Ctrl for copy and emits a no-overwrite confirmation', () => {
    expect(transferMode(true)).toBe('copy');
    expect(transferMode(false)).toBe('move');
    expect(transferConfirmation(entry, 'target', 'move')).toContain('不会覆盖');
  });
});

describe('workspace pointer drag targets', () => {
  it('accepts another folder but rejects the current parent, itself and descendants', () => {
    expect(canTransferEntry(entry, target('target'))).toBe(true);
    expect(canTransferEntry(entry, target(''))).toBe(true);
    expect(canTransferEntry(entry, target('folder'))).toBe(false);
    expect(canTransferEntry(entry, target('folder/source.txt'))).toBe(false);

    const directory: DirectoryEntry = {
      ...entry,
      ref: { ...entry.ref, relativePath: 'folder' },
      name: 'folder',
      kind: 'directory',
    };
    expect(canTransferEntry(directory, target('folder/child'))).toBe(false);
    expect(canTransferEntry(directory, target('other'))).toBe(true);
  });

  it('rejects links and accepts an empty-path root in another workspace root', () => {
    expect(canTransferEntry({ ...entry, kind: 'symlink' }, target('target'))).toBe(false);
    expect(canTransferEntry(entry, target('', 'other-grant'))).toBe(true);
  });
});

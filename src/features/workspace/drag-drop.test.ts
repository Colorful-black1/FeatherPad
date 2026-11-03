import { describe, expect, it } from 'vitest';
import type { DirectoryEntry } from '../../shared/contracts/files';
import { dragPayload, parseDragPayload, transferConfirmation, transferMode } from './drag-drop';

const entry: DirectoryEntry = {
  id: 'source',
  ref: { grantId: 'grant', relativePath: 'folder/source.txt' } as DirectoryEntry['ref'],
  name: 'source.txt',
  kind: 'file',
  isHidden: false,
  isReadOnly: false,
  revision: 'a'.repeat(64),
};

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

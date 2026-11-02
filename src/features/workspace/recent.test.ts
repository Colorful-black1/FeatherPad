import { expect, it } from 'vitest';
import type { FileRef, OpenDocument } from '../../shared/contracts/files';
import type { JsonValue } from '../../shared/contracts/settings';
import {
  addRecentEntry, clearRecentHistory, MAX_RECENT_ENTRIES, readRecentHistory, recentFileCandidate,
  recentGrantIds, recentWorkspaceCandidate, removeRecentEntry, writeRecentHistory, type RecentCandidate,
} from './recent';

const grantId = '11111111-1111-4111-8111-111111111111' as FileRef['grantId'];
const otherGrantId = '22222222-2222-4222-8222-222222222222' as FileRef['grantId'];

function opened(path = 'E:\\fixtures\\note.txt', identity = 'a'.repeat(64)): OpenDocument {
  return {
    documentId: 'document-1' as OpenDocument['documentId'],
    canonicalIdentity: identity,
    ref: { grantId, relativePath: '' },
    metadata: {
      displayPath: path, sizeBytes: 4, modifiedAt: '2026-11-02T00:00:00.000Z',
      isReadOnly: false, diskRevision: 'b'.repeat(64) as OpenDocument['metadata']['diskRevision'],
    },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
    warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'note', newlineMap: { documentVersion: 0, endings: [] } },
  };
}

function candidate(index: number, identity = `identity-${index}`): RecentCandidate {
  return {
    kind: 'file',
    canonicalIdentity: identity,
    ref: { grantId, relativePath: `folder/${index}.txt` },
    title: `${index}.txt`,
    displayPath: `E:\\fixtures\\folder\\${index}.txt`,
    lastOpenedAt: new Date(Date.UTC(2026, 10, 2, 0, 0, index)).toISOString(),
  };
}

it('uses native canonical identity to deduplicate independent and tree grants and keeps only open metadata', () => {
  const first = recentFileCandidate(opened(), '2026-11-02T00:00:00.000Z');
  const secondOpen = {
    ...opened('E:\\fixtures\\renamed.txt'),
    ref: { grantId: otherGrantId, relativePath: 'renamed.txt' },
  };
  const second = recentFileCandidate(secondOpen, '2026-11-02T00:01:00.000Z');
  const entries = addRecentEntry(addRecentEntry([], first), second);

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    ref: { grantId: otherGrantId, relativePath: 'renamed.txt' },
    title: 'renamed.txt',
    lastOpenedAt: '2026-11-02T00:01:00.000Z',
  });
  expect(entries[0]).not.toHaveProperty('text');
  expect(entries[0]).not.toHaveProperty('searchQuery');
  expect(entries[0]).not.toHaveProperty('clipboard');
});

it('keeps at most 50 newest entries and persists a bounded versioned document', () => {
  let entries = readRecentHistory(undefined);
  for (let index = 0; index < MAX_RECENT_ENTRIES + 3; index++) entries = addRecentEntry(entries, candidate(index));
  expect(entries).toHaveLength(MAX_RECENT_ENTRIES);
  expect(entries[0]?.title).toBe('52.txt');
  expect(entries.at(-1)?.title).toBe('3.txt');

  const stored = writeRecentHistory(entries);
  expect(stored).toMatchObject({ schemaVersion: 1 });
  expect(readRecentHistory(stored)).toEqual(entries);
});

it('separates files and workspaces, removes one item and clears the whole list independently', () => {
  const file = addRecentEntry([], candidate(1));
  const workspace = addRecentEntry(file, recentWorkspaceCandidate(
    { grantId: otherGrantId, relativePath: '' },
    'controlled-workspace',
    '2026-11-02T00:02:00.000Z',
  ));
  expect(workspace.map(entry => entry.kind)).toEqual(['workspace', 'file']);
  expect(recentGrantIds(workspace)).toEqual([otherGrantId, grantId]);
  expect(removeRecentEntry(workspace, workspace[0]!.id)).toEqual(file);
  expect(clearRecentHistory()).toEqual([]);
});

it('rejects malformed, over-limit and future data without manufacturing entries', () => {
  expect(readRecentHistory({ schemaVersion: 2, entries: [candidate(1)] } as unknown as JsonValue)).toEqual([]);
  expect(readRecentHistory({ schemaVersion: 1, entries: [{ ...candidate(1), id: 'wrong' }] } as unknown as JsonValue)).toEqual([]);
  const stored = { ...candidate(1), id: `file:${candidate(1).canonicalIdentity}` };
  expect(readRecentHistory({
    schemaVersion: 1,
    entries: Array.from({ length: MAX_RECENT_ENTRIES + 1 }, () => stored),
  } as unknown as JsonValue)).toEqual([]);
});

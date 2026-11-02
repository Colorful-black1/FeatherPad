import { expect, it } from 'vitest';
import type { DirectoryEntry, DocumentId, GrantId } from '../shared/contracts/files';
import { WorkspaceStore } from '../features/workspace/store';
import { quickCandidates } from './quick-candidates';

const grantId = 'owned-root' as GrantId;
const entry = (relativePath: string, kind: DirectoryEntry['kind'] = 'file'): DirectoryEntry => ({ id: relativePath,
  name: relativePath.split('/').at(-1)!, ref: { grantId, relativePath }, kind, isHidden: false, isReadOnly: false, revision: 'a'.repeat(64) });

it('merges open documents with authorized loaded tree candidates, keeping same-name paths and excluding links', () => {
  const snapshot = new WorkspaceStore().getSnapshot();
  const first = entry('one/note.txt');
  const records = { '': { items: [first, entry('two/note.txt'), entry('link', 'symlink'), entry('folder', 'directory'),
    { ...entry('.hidden'), isHidden: true }, { ...entry('foreign'), ref: { grantId: 'other' as GrantId, relativePath: 'foreign' } }],
    nextCursor: 'unloaded-page', loaded: true, loading: false, error: null } };
  const result = quickCandidates([{ id: 'one' as DocumentId, title: 'note.txt', displayPath: 'E:/owned/one/note.txt', ref: first.ref }],
    { ...snapshot, root: { grant: { grantId, relativePath: '' }, displayName: 'owned' }, records });
  expect(result.items.map(item => item.title)).toEqual(['note.txt', 'note.txt']);
  expect(result.items.map(item => item.detail)).toEqual(['E:/owned/one/note.txt', 'owned/two/note.txt']);
  expect([...result.targets.values()]).toEqual([{ kind: 'document', id: 'one' }, { kind: 'file', ref: { grantId, relativePath: 'two/note.txt' } }]);
  expect(result.scope).toContain('已加载');
});

it('bounds candidate retention without reading disk or storing document body', () => {
  const result = quickCandidates(Array.from({ length: 5_001 }, (_, index) => ({ id: String(index) as DocumentId,
    title: `draft-${index}`, displayPath: null, ref: null })), new WorkspaceStore().getSnapshot());
  expect(result.items).toHaveLength(5_000);
  expect(result.targets.size).toBe(5_000);
  expect(result.scope).toContain('上限');
});

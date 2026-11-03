import { expect, it, vi } from 'vitest';
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from '../../bridge/search';
import type { DocumentId, FileRef, GrantId } from '../../shared/contracts/files';
import { WorkspaceSearchStore, type BufferedWorkspaceDocument, type WorkspaceSearchOptions } from './workspace-search';

const requestId = '11111111-1111-4111-8111-111111111111';
const root: FileRef = { grantId: 'root' as GrantId, relativePath: '' };
const options = (id = requestId): WorkspaceSearchOptions => ({
  requestId: id,
  roots: [root],
  query: { pattern: 'alpha', isRegex: false, isCaseSensitive: false, isWholeWord: false },
  include: [], exclude: [], respectGitignore: true, followDirectoryLinks: false, includeHidden: false,
});
const result = (id: string, files: WorkspaceSearchResult['files'] = []): WorkspaceSearchResult => ({
  requestId: id, files, skipped: [], totalMatches: files.reduce((sum, file) => sum + file.matches.length, 0),
  scannedFiles: files.length, truncated: false, cancelled: false, elapsedMs: 12,
});

it('replaces stale disk results with dirty buffer matches and marks their source', async () => {
  const disk = {
    ref: { grantId: 'root' as GrantId, relativePath: 'a.txt' },
    displayName: 'a.txt', displayPath: 'E:/root/a.txt', revision: 'a'.repeat(64), encoding: 'utf-8',
    matches: [{ line: 1, column: 1, start: 0, end: 5, snippet: 'alpha old', prefixTruncated: false, suffixTruncated: false }],
    truncated: false,
  };
  const store = new WorkspaceSearchStore(
    vi.fn(async () => ({ ok: true as const, value: result(requestId, [disk]) })),
    vi.fn(async () => ({ ok: true as const, value: { requestId } })),
  );
  const dirty: BufferedWorkspaceDocument = {
    id: 'doc' as DocumentId, ref: { grantId: 'root' as GrantId, relativePath: 'a.txt' },
    displayName: 'a.txt', displayPath: 'E:/root/a.txt', text: 'alpha buffer', version: 4,
  };
  await store.start(options(), [dirty]);
  expect(store.getSnapshot()).toMatchObject({ phase: 'complete', totalMatches: 1, elapsedMs: 12 });
  expect(store.getSnapshot().files).toHaveLength(1);
  expect(store.getSnapshot().files[0]).toMatchObject({ encoding: 'buffer', revision: 'buffer-4' });
  expect(store.getSnapshot().dirtyFiles).toHaveLength(1);
});

it('drops a late result after a newer query and cancels the superseded request', async () => {
  const firstId = requestId;
  const secondId = '22222222-2222-4222-8222-222222222222';
  let resolveFirst!: (value: { ok: true; value: WorkspaceSearchResult }) => void;
  let resolveSecond!: (value: { ok: true; value: WorkspaceSearchResult }) => void;
  const run = vi.fn((request: WorkspaceSearchRequest) => new Promise<{ ok: true; value: WorkspaceSearchResult }>(resolve => {
    if (request.requestId === firstId) resolveFirst = resolve;
    else resolveSecond = resolve;
  }));
  const cancel = vi.fn(async (id: string) => ({ ok: true as const, value: { requestId: id } }));
  const store = new WorkspaceSearchStore(run, cancel);
  const first = store.start(options(firstId));
  const second = store.start(options(secondId));
  expect(cancel).toHaveBeenCalledWith(firstId);
  resolveSecond({ ok: true, value: result(secondId) });
  await second;
  resolveFirst({ ok: true, value: result(firstId) });
  await first;
  expect(store.getSnapshot()).toMatchObject({ phase: 'complete', requestId: secondId });
});

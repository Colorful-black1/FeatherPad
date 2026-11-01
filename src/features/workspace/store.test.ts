import { expect, it } from 'vitest';
import type {
  DirectoryEntry, DirectoryPage, FileRef, ListDirectoryRequest, ResultEnvelope,
} from '../../shared/contracts/files';
import { WorkspaceStore } from './store';

const grant = { grantId: 'workspace-grant', relativePath: '' } as FileRef;

function entry(name: string, relativePath: string, kind: DirectoryEntry['kind'] = 'file'): DirectoryEntry {
  return {
    id: relativePath, ref: { grantId: grant.grantId, relativePath }, name, kind,
    isHidden: false, isReadOnly: false,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('loads only the root then opens and pages an expanded directory lazily', async () => {
  const calls: ListDirectoryRequest[] = [];
  const folder = entry('folder', 'folder', 'directory');
  const rootFile = entry('root.txt', 'root.txt');
  const nested = entry('nested.txt', 'folder/nested.txt');
  const store = new WorkspaceStore(async request => {
    calls.push(request);
    if (request.ref.relativePath === '') {
      return { ok: true, value: {
        items: request.cursor ? [rootFile] : [folder],
        nextCursor: request.cursor ? null : 'root-next',
      } };
    }
    return { ok: true, value: { items: [nested], nextCursor: null } };
  });

  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  expect(calls).toHaveLength(1);
  expect(store.getSnapshot().records['']?.items).toEqual([folder]);

  store.loadMore(null);
  await flush();
  expect(calls[1]).toMatchObject({ cursor: 'root-next' });
  expect(store.getSnapshot().records['']?.items).toEqual([folder, rootFile]);

  store.toggleDirectory(folder);
  await flush();
  expect(calls[2]?.ref.relativePath).toBe('folder');
  expect(store.getSnapshot().expanded.folder).toBe(true);
  expect(store.getSnapshot().records.folder?.items).toEqual([nested]);
});

it('resets stale pages for hidden filtering and locates a nested current file', async () => {
  const calls: ListDirectoryRequest[] = [];
  const folder = entry('folder', 'folder', 'directory');
  const file = entry('nested.txt', 'folder/nested.txt');
  const hidden = { ...entry('.hidden', '.hidden'), isHidden: true };
  const store = new WorkspaceStore(async request => {
    calls.push(request);
    if (request.ref.relativePath === '') {
      return { ok: true, value: {
        items: request.showHidden ? [folder, hidden] : [folder], nextCursor: null,
      } };
    }
    return { ok: true, value: { items: [file], nextCursor: null } };
  });

  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  expect(await store.locate(file.ref)).toBe(true);
  expect(store.getSnapshot().expanded.folder).toBe(true);
  expect(store.getSnapshot().selectedPath).toBe('folder/nested.txt');

  store.setShowHidden(true);
  await flush();
  expect(calls.at(-1)).toMatchObject({ showHidden: true });
  expect(store.getSnapshot().expanded.folder).toBeUndefined();
  expect(store.getSnapshot().records['']?.items.some(item => item.name === '.hidden')).toBe(true);
});

it('keeps a failed directory visible for retry and refuses a file outside its root', async () => {
  let fail = true;
  const store = new WorkspaceStore(async () => fail
    ? { ok: false, error: { code: 'PERMISSION_DENIED', message: 'controlled denied directory', retryable: true } }
    : { ok: true, value: { items: [], nextCursor: null } });
  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  expect(store.getSnapshot().records['']?.error).toContain('controlled denied');

  fail = false;
  store.refresh();
  await flush();
  expect(store.getSnapshot().records['']?.loaded).toBe(true);
  expect(store.getSnapshot().records['']?.error).toBeNull();
  expect(await store.locate({ grantId: 'different-grant' as FileRef['grantId'], relativePath: 'outside.txt' })).toBe(false);
  expect(store.getSnapshot().rootError).toContain('不在');
});

it('refreshes an expanded child and discards its older in-flight page', async () => {
  const folder = entry('folder', 'folder', 'directory');
  const staleFile = entry('stale.txt', 'folder/stale.txt');
  const freshFile = entry('fresh.txt', 'folder/fresh.txt');
  const childRequests: ((value: ResultEnvelope<DirectoryPage>) => void)[] = [];
  const store = new WorkspaceStore(request => {
    if (request.ref.relativePath === '') {
      return Promise.resolve({ ok: true, value: { items: [folder], nextCursor: null } });
    }
    return new Promise(resolve => { childRequests.push(resolve); });
  });

  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  store.toggleDirectory(folder);
  await flush();
  expect(store.getSnapshot().records.folder?.loading).toBe(true);

  store.refresh();
  await flush();
  expect(store.getSnapshot().expanded.folder).toBe(true);
  expect(store.getSnapshot().records.folder?.loading).toBe(true);
  expect(childRequests).toHaveLength(2);

  childRequests[0]?.({ ok: true, value: { items: [staleFile], nextCursor: null } });
  await flush();
  expect(store.getSnapshot().records.folder?.items).toEqual([]);
  expect(store.getSnapshot().records.folder?.loading).toBe(true);

  childRequests[1]?.({ ok: true, value: { items: [freshFile], nextCursor: null } });
  await flush();
  expect(store.getSnapshot().records.folder?.items).toEqual([freshFile]);
  expect(store.getSnapshot().expanded.folder).toBe(true);
});

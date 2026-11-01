import { expect, it } from 'vitest';
import type {
  CreateEntryRequest, DirectoryEntry, DirectoryPage, DocumentId, FileRef, ListDirectoryRequest,
  RenameEntryRequest, ResultEnvelope,
} from '../../shared/contracts/files';
import { WorkspaceStore } from './store';

const grant = { grantId: 'workspace-grant', relativePath: '' } as FileRef;

function entry(name: string, relativePath: string, kind: DirectoryEntry['kind'] = 'file'): DirectoryEntry {
  return {
    id: relativePath, ref: { grantId: grant.grantId, relativePath }, name, kind,
    isHidden: false, isReadOnly: false, revision: 'a'.repeat(64),
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

it('inserts a created entry and remaps expanded records after a directory rename', async () => {
  const folder = entry('folder', 'folder', 'directory');
  const child = entry('child.txt', 'folder/child.txt');
  const created: CreateEntryRequest[] = [];
  const renamed: RenameEntryRequest[] = [];
  const renamedFolder = {
    ...folder,
    id: 'renamed-folder',
    name: 'renamed',
    ref: { grantId: grant.grantId, relativePath: 'renamed' },
  };
  let rootItems = [folder];
  const store = new WorkspaceStore(
    async request => ({
      ok: true,
      value: request.ref.relativePath === ''
        ? { items: rootItems, nextCursor: null }
        : { items: [child], nextCursor: null },
    }),
    async request => {
      created.push(request);
      const createdEntry = entry(request.name, request.name, request.kind);
      rootItems = [...rootItems, createdEntry];
      return {
        ok: true,
        value: createdEntry,
      };
    },
    async request => {
      renamed.push(request);
      rootItems = [renamedFolder];
      return {
        ok: true,
        value: {
          entry: renamedFolder,
          renamedDocuments: [{
            documentId: 'document-1' as DocumentId,
            ref: { grantId: grant.grantId, relativePath: 'renamed/child.txt' },
            displayPath: 'E:\\fixture\\renamed\\child.txt',
          }],
        },
      };
    },
  );
  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  store.toggleDirectory(folder);
  await flush();

  const createdResult = await store.createEntry(grant, 'new.txt', 'file');
  expect(createdResult.ok).toBe(true);
  expect(created[0]).toMatchObject({ name: 'new.txt', kind: 'file' });
  expect(store.getSnapshot().records['']?.items.map(item => item.name)).toEqual(['folder', 'new.txt']);
  expect(store.getSnapshot().selectedPath).toBe('new.txt');

  store.select(folder);
  const renameResult = await store.renameEntry(folder, 'renamed');
  expect(renameResult.ok).toBe(true);
  expect(renamed[0]).toMatchObject({ newName: 'renamed', expectedRevision: 'a'.repeat(64) });
  expect(store.getSnapshot().records.folder).toBeUndefined();
  expect(store.getSnapshot().records.renamed?.items[0]?.ref.relativePath).toBe('renamed/child.txt');
  expect(store.getSnapshot().expanded.renamed).toBe(true);
  expect(store.getSnapshot().selectedPath).toBe('renamed');
});

it('refreshes a containing directory revision after changing one of its children', async () => {
  let folderRevision = '1'.repeat(64);
  const folder = {
    ...entry('folder', 'folder', 'directory'),
    revision: folderRevision,
  };
  const children: DirectoryEntry[] = [];
  const renameRequests: RenameEntryRequest[] = [];
  const store = new WorkspaceStore(
    async request => ({
      ok: true,
      value: request.ref.relativePath === ''
        ? { items: [{ ...folder, revision: folderRevision }], nextCursor: null }
        : { items: children, nextCursor: null },
    }),
    async request => {
      folderRevision = '2'.repeat(64);
      const createdEntry = entry(request.name, `${request.parent.relativePath}/${request.name}`);
      children.push(createdEntry);
      return { ok: true, value: createdEntry };
    },
    async request => {
      renameRequests.push(request);
      folderRevision = '3'.repeat(64);
      const renamedFolder = {
        ...folder,
        id: 'renamed-folder',
        name: request.newName,
        ref: { grantId: grant.grantId, relativePath: request.newName },
        revision: folderRevision,
      };
      return {
        ok: true,
        value: { entry: renamedFolder, renamedDocuments: [] },
      };
    },
  );

  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  store.toggleDirectory(folder);
  await flush();
  await store.createEntry(folder.ref, 'inside.txt', 'file');
  const refreshed = store.getSnapshot().records['']?.items.find(item => item.name === 'folder');
  expect(refreshed?.revision).toBe('2'.repeat(64));
  if (!refreshed) throw new Error('Refreshed directory entry missing');

  await store.renameEntry(refreshed, 'renamed');
  expect(renameRequests[0]?.expectedRevision).toBe('2'.repeat(64));
});

it('does not apply a completed create to a workspace root that replaced it', async () => {
  const newGrant = { grantId: 'new-workspace-grant', relativePath: '' } as FileRef;
  const oldRoot = entry('old.txt', 'old.txt');
  const newRoot = {
    ...entry('new.txt', 'new.txt'),
    ref: { grantId: newGrant.grantId, relativePath: 'new.txt' },
  };
  let finishCreate: ((value: ResultEnvelope<DirectoryEntry>) => void) | undefined;
  const store = new WorkspaceStore(
    async request => ({
      ok: true,
      value: { items: request.ref.grantId === grant.grantId ? [oldRoot] : [newRoot], nextCursor: null },
    }),
    request => new Promise(resolve => {
      finishCreate = resolve;
      expect(request.parent).toEqual(grant);
    }),
  );

  store.setRoot({ grant, displayName: 'old-root' });
  await flush();
  const creating = store.createEntry(grant, 'late.txt', 'file');
  store.setRoot({ grant: newGrant, displayName: 'new-root' });
  await flush();
  finishCreate?.({
    ok: true,
    value: entry('late.txt', 'late.txt'),
  });
  const result = await creating;

  expect(result.ok).toBe(true);
  expect(store.getSnapshot().root?.grant).toEqual(newGrant);
  expect(store.getSnapshot().records['']?.items).toEqual([newRoot]);
  expect(store.getSnapshot().selectedPath).toBeNull();
});

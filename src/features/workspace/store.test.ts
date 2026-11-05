import { expect, it } from 'vitest';
import type {
  CreateEntryRequest, DirectoryEntry, DirectoryPage, DocumentId, FileRef, ListDirectoryRequest,
  RenameEntryRequest, ResultEnvelope, TransferEntryRequest, TrashEntryRequest, TrashEntryResult,
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

it('deduplicates physical roots, restores per-root tree state, reorders and removes without touching file contents', async () => {
  const calls: string[] = [];
  const store = new WorkspaceStore(async request => {
    calls.push(request.ref.grantId);
    return { ok: true, value: { items: [{ ...entry('root.txt', 'root.txt'), ref: { ...request.ref, relativePath: 'root.txt' } }], nextCursor: null } };
  });
  const first = { grant, displayName: 'same-name', canonicalIdentity: 'a'.repeat(64) };
  const second = { grant: { ...grant, grantId: 'second' as FileRef['grantId'] }, displayName: 'same-name', canonicalIdentity: 'b'.repeat(64) };
  store.addRoot(first); await flush(); store.select(store.getSnapshot().records['']!.items[0]!);
  store.addRoot(second); await flush();
  expect(store.getSnapshot().roots).toHaveLength(2);
  store.addRoot({ ...first, grant: { ...grant, grantId: 'alias' as FileRef['grantId'] } });
  expect(store.getSnapshot().roots).toHaveLength(2);
  expect(store.getSnapshot().selectedPath).toBe('root.txt'); expect(calls).toHaveLength(2);
  expect(store.reorderRoots([second.grant.grantId, first.grant.grantId])).toBe(true);
  expect(store.reorderRoots([first.grant.grantId, first.grant.grantId])).toBe(false);
  store.removeRoot(first.grant.grantId);
  expect(store.getSnapshot().root?.grant.grantId).toBe(second.grant.grantId);
  expect(store.getSnapshot().roots).toEqual([second]);
});

it('keeps failed or uncertain trash entries and removes them only after a matching receipt', async () => {
  const source = entry('source.txt', 'source.txt');
  const items: DirectoryEntry[] = [source];
  let outcome: ResultEnvelope<TrashEntryResult> = { ok: false,
    error: { code: 'TRASH_UNAVAILABLE', message: 'Controlled recycle failure', retryable: false } };
  const store = new WorkspaceStore(async () => ({ ok: true, value: { items: [...items], nextCursor: null } }),
    undefined, undefined, async () => outcome);
  store.setRoot({ grant, displayName: 'fixture' });
  await flush();
  const request: TrashEntryRequest = { ref: source.ref, expectedRevision: source.revision,
    expectedIdentity: 'b'.repeat(64), requestId: 'operation', affectedDocumentIds: [], snapshots: [] };
  expect((await store.trashEntry(request)).ok).toBe(false);
  expect(store.getSnapshot().records['']?.items).toEqual([source]);
  outcome = { ok: true, value: { trashed: true, receiptId: 'wrong-operation', missingDocumentIds: [], drafts: [] } };
  expect((await store.trashEntry(request)).ok).toBe(false);
  expect(store.getSnapshot().records['']?.items).toEqual([source]);
  outcome.value.receiptId = request.requestId;
  items.length = 0;
  expect((await store.trashEntry(request)).ok).toBe(true);
  expect(store.getSnapshot().records['']?.items).toEqual([]);
});

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

it('keeps the latest active file selected when automatic locate requests overlap', async () => {
  const first = entry('first.txt', 'first.txt');
  const latest = entry('latest.txt', 'latest.txt');
  let finish!: (value: ResultEnvelope<DirectoryPage>) => void;
  const store = new WorkspaceStore(() => new Promise(resolve => { finish = resolve; }));
  store.setRoot({ grant, displayName: 'fixture-root' });
  const earlier = store.locate(first.ref);
  const later = store.locate(latest.ref);
  finish({ ok: true, value: { items: [first, latest], nextCursor: null } });
  expect(await earlier).toBe(false);
  expect(await later).toBe(true);
  expect(store.getSnapshot().selectedPath).toBe('latest.txt');
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

it('applies a verified move across the tree and publishes document rebindings', async () => {
  const folder = entry('folder', 'folder', 'directory');
  const target = entry('target', 'target', 'directory');
  const source = entry('source.txt', 'folder/source.txt');
  let transferRequest: TransferEntryRequest | null = null;
  const rootItems = [folder, target];
  let moved = false;
  const store = new WorkspaceStore(
    async request => ({
      ok: true,
      value: {
        items: request.ref.relativePath === '' ? rootItems
          : request.ref.relativePath === 'folder' ? (moved ? [] : [source])
            : request.ref.relativePath === 'target'
              ? (moved ? [{ ...source, ref: { grantId: grant.grantId, relativePath: 'target/source.txt' } }] : [])
              : [],
        nextCursor: null,
      },
    }),
    undefined,
    undefined,
    undefined,
    async request => {
      transferRequest = request;
      moved = true;
      return {
        ok: true,
        value: {
          entry: { ...source, ref: { grantId: grant.grantId, relativePath: 'target/source.txt' } },
          renamedDocuments: [{
            documentId: 'document-1' as DocumentId,
            ref: { grantId: grant.grantId, relativePath: 'target/source.txt' },
            displayPath: 'E:\\fixture\\target\\source.txt',
          }],
          mode: 'move',
          sourceRemoved: true,
        },
      };
    },
  );
  store.setRoot({ grant, displayName: 'fixture-root' });
  await flush();
  store.toggleDirectory(folder);
  store.toggleDirectory(target);
  await flush();

  const result = await store.transferEntry(source, target.ref, 'move');
  expect(result.ok).toBe(true);
  expect(transferRequest).toMatchObject({
    source: source.ref,
    targetParent: target.ref,
    mode: 'move',
    expectedRevision: source.revision,
  });
  expect(store.getSnapshot().records.folder?.items).toEqual([]);
  expect(store.getSnapshot().records.target?.items[0]?.ref.relativePath).toBe('target/source.txt');
  expect(store.getSnapshot().selectedPath).toBe('target/source.txt');
});

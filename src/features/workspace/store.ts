import { files } from '../../bridge/files';
import type {
  CreateEntryRequest, DirectoryEntry, DirectoryPage, FileRef, ListDirectoryRequest,
  RenameEntryRequest, RenameEntryResult, ResultEnvelope, TrashEntryRequest, TrashEntryResult,
  TransferEntryRequest, TransferEntryResult,
} from '../../shared/contracts/files';
import { defaultWorkspaceFilters, normalizedFilters, type WorkspaceFilters } from './filters';

export interface WorkspaceRoot {
  grant: FileRef;
  displayName: string;
  rootId?: string;
  displayPath?: string;
  canonicalIdentity?: string;
}

export interface DirectoryRecord {
  items: readonly DirectoryEntry[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface WorkspaceSnapshot {
  root: WorkspaceRoot | null;
  roots: readonly WorkspaceRoot[];
  records: Readonly<Record<string, DirectoryRecord>>;
  expanded: Readonly<Record<string, true>>;
  selectedPath: string | null;
  showHidden: boolean;
  rootError: string | null;
  filters: WorkspaceFilters;
  syncStatus: { kind: 'ready' | 'syncing' | 'unavailable'; message: string | null };
}

type ListDirectory = (request: ListDirectoryRequest) => Promise<ResultEnvelope<DirectoryPage>>;
type CreateEntry = (request: CreateEntryRequest) => Promise<ResultEnvelope<DirectoryEntry>>;
type RenameEntry = (request: RenameEntryRequest) => Promise<ResultEnvelope<RenameEntryResult>>;
type TrashEntry = (request: TrashEntryRequest) => Promise<ResultEnvelope<TrashEntryResult>>;
type TransferEntry = (request: TransferEntryRequest) => Promise<ResultEnvelope<TransferEntryResult>>;

const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function compareEntries(left: DirectoryEntry, right: DirectoryEntry) {
  const kind = Number(right.kind === 'directory') - Number(left.kind === 'directory');
  return kind || nameCollator.compare(left.name, right.name) || left.name.localeCompare(right.name);
}

const emptyRecord = (): DirectoryRecord => ({
  items: [], nextCursor: null, loaded: false, loading: false, error: null,
});

const isAtOrBelow = (candidate: string, parent: string) =>
  parent === '' || candidate === parent || candidate.startsWith(`${parent}/`);

const initialSnapshot = (): WorkspaceSnapshot => ({
  root: null, roots: [], records: { '': emptyRecord() }, expanded: {}, selectedPath: null,
  showHidden: false, rootError: null, filters: { ...defaultWorkspaceFilters },
  syncStatus: { kind: 'ready', message: null },
});

export class WorkspaceStore {
  private readonly listDirectory: ListDirectory;
  private readonly createEntryAction: CreateEntry;
  private readonly renameEntryAction: RenameEntry;
  private readonly trashEntryAction: TrashEntry;
  private readonly transferEntryAction: TransferEntry;
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, DirectoryRecord>();
  private readonly expanded = new Set<string>();
  private readonly requestVersions = new Map<string, number>();
  private snapshot: WorkspaceSnapshot;
  private root: WorkspaceRoot | null = null;
  private roots: readonly WorkspaceRoot[] = [];
  private readonly rootStates = new Map<string, WorkspaceSnapshot>();
  private showHidden = false;
  private selectedPath: string | null = null;
  private rootError: string | null = null;
  private filters: WorkspaceFilters = { ...defaultWorkspaceFilters };
  private syncStatus: WorkspaceSnapshot['syncStatus'] = { kind: 'ready', message: null };
  private generation = 0;

  constructor(
    listDirectory: ListDirectory = request => files.listDirectory(request),
    createEntry: CreateEntry = request => files.createEntry(request),
    renameEntry: RenameEntry = request => files.renameEntry(request),
    trashEntry: TrashEntry = request => files.trashEntry(request),
    transferEntry: TransferEntry = request => files.transferEntry(request),
  ) {
    this.listDirectory = listDirectory;
    this.createEntryAction = createEntry;
    this.renameEntryAction = renameEntry;
    this.trashEntryAction = trashEntry;
    this.transferEntryAction = transferEntry;
    this.records.set('', emptyRecord());
    this.snapshot = initialSnapshot();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  setRoot(root: WorkspaceRoot | null) {
    this.roots = root ? [root] : [];
    this.rootStates.clear();
    this.resetRoot(root);
  }

  replaceRoots(roots: readonly WorkspaceRoot[]) {
    const unique: WorkspaceRoot[] = [];
    for (const root of roots) if (!unique.some(item => item.grant.grantId === root.grant.grantId
      || (!!item.canonicalIdentity && item.canonicalIdentity === root.canonicalIdentity))) unique.push(root);
    if (unique.length > 16) return false;
    this.roots = unique; this.rootStates.clear(); this.resetRoot(unique[0] ?? null); return true;
  }

  addRoot(root: WorkspaceRoot) {
    const existing = this.roots.find(item => item.grant.grantId === root.grant.grantId
      || (!!item.canonicalIdentity && item.canonicalIdentity === root.canonicalIdentity));
    if (existing) { this.activateRoot(existing.grant.grantId); return true; }
    if (this.roots.length >= 16) { this.rootError = '工作区最多包含16个根。'; this.publish(); return false; }
    this.roots = [...this.roots, root]; this.activateRoot(root.grant.grantId); return true;
  }

  reorderRoots(ids: readonly string[]) {
    if (ids.length !== this.roots.length || new Set(ids).size !== ids.length) return false;
    const roots = ids.map(id => this.roots.find(root => root.grant.grantId === id));
    if (roots.some(root => !root)) return false;
    this.roots = roots.filter((root): root is WorkspaceRoot => !!root); this.publish(); return true;
  }

  removeRoot(grantId: string) {
    // Caller first revokes the native directory grant and rebinds open documents.
    this.roots = this.roots.filter(root => root.grant.grantId !== grantId);
    this.rootStates.delete(grantId);
    if (this.root?.grant.grantId === grantId) this.resetRoot(this.roots[0] ?? null);
    else this.publish();
  }

  activateRoot(grantId: string) {
    const root = this.roots.find(item => item.grant.grantId === grantId);
    if (!root || this.root?.grant.grantId === grantId) { this.publish(); return; }
    if (this.root) this.rootStates.set(this.root.grant.grantId, this.snapshot);
    const previous = this.rootStates.get(grantId);
    this.resetRoot(root, false);
    if (previous) {
      this.records.clear();
      for (const [path, record] of Object.entries(previous.records)) this.records.set(path, { ...record, loading: false });
      for (const path of Object.keys(previous.expanded)) this.expanded.add(path);
      this.selectedPath = previous.selectedPath; this.rootError = previous.rootError;
      this.publish();
    }
    if (!this.records.get('')?.loaded) void this.load(root.grant, false);
  }

  private resetRoot(root: WorkspaceRoot | null, load = true) {
    this.generation++;
    this.root = root;
    this.records.clear();
    this.expanded.clear();
    this.requestVersions.clear();
    this.selectedPath = null;
    this.rootError = null;
    this.records.set('', emptyRecord());
    this.publish();
    if (root && load) void this.load(root.grant, false);
  }

  clearRoot() {
    this.setRoot(null);
  }

  setShowHidden(showHidden: boolean) {
    if (this.showHidden === showHidden) return;
    this.generation++;
    this.showHidden = showHidden;
    this.rootStates.clear();
    const root = this.root;
    this.records.clear();
    this.expanded.clear();
    this.requestVersions.clear();
    this.selectedPath = null;
    this.rootError = null;
    this.records.set('', emptyRecord());
    this.publish();
    if (root) void this.load(root.grant, false);
  }

  setFilters(filters: WorkspaceFilters) {
    this.filters = normalizedFilters(filters);
    this.publish();
  }

  setSyncStatus(status: WorkspaceSnapshot['syncStatus']) {
    if (this.syncStatus.kind === status.kind && this.syncStatus.message === status.message) return;
    this.syncStatus = status;
    this.publish();
  }

  select(entry: DirectoryEntry) {
    this.selectedPath = entry.ref.relativePath;
    this.publish();
  }

  toggleDirectory(entry: DirectoryEntry) {
    if (entry.kind !== 'directory') return;
    const key = entry.ref.relativePath;
    this.selectedPath = key;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else {
      this.expanded.add(key);
      const record = this.records.get(key);
      if (!record?.loaded && !record?.loading) void this.load(entry.ref, false);
    }
    this.publish();
  }

  collapseDirectory(entry: DirectoryEntry) {
    if (this.expanded.delete(entry.ref.relativePath)) this.publish();
  }

  loadMore(reference: FileRef | null) {
    if (!this.root) return;
    const target = reference ?? this.root.grant;
    const record = this.records.get(target.relativePath);
    if (!record?.nextCursor || record.loading) return;
    void this.load(target, true);
  }

  refresh(reference: FileRef | null = null) {
    if (!this.root) return;
    const target = reference ?? this.root.grant;
    const key = target.relativePath;
    const preservedExpanded = [...this.expanded].filter(expandedKey => isAtOrBelow(expandedKey, key));
    for (const recordKey of [...this.records.keys()]) {
      if (isAtOrBelow(recordKey, key)) this.records.delete(recordKey);
    }
    for (const requestKey of [...this.requestVersions.keys()]) {
      if (isAtOrBelow(requestKey, key)) {
        this.requestVersions.set(requestKey, (this.requestVersions.get(requestKey) ?? 0) + 1);
      }
    }
    if (key) this.expanded.add(key);
    this.records.set(key, emptyRecord());
    this.rootError = null;
    this.publish();
    const requestGeneration = this.generation;
    void this.load(target, false).then(result => {
      if (!result?.ok || requestGeneration !== this.generation || !this.root) return;
      const grantId = this.root.grant.grantId;
      for (const relativePath of preservedExpanded) {
        if (relativePath !== key) void this.load({ grantId, relativePath }, false);
      }
    });
  }

  async createEntry(
    parent: FileRef,
    name: string,
    kind: 'file' | 'directory',
  ): Promise<ResultEnvelope<DirectoryEntry>> {
    const requestGeneration = this.generation;
    const result = await this.createEntryAction({
      parent,
      name,
      kind,
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) return result;
    if (requestGeneration !== this.generation || this.root?.grant.grantId !== parent.grantId) {
      return result;
    }
    const record = this.records.get(parent.relativePath) ?? emptyRecord();
    const existing = record.items.filter(item => item.ref.relativePath !== result.value.ref.relativePath);
    this.records.set(parent.relativePath, {
      items: [...existing, result.value].sort(compareEntries),
      nextCursor: record.nextCursor,
      loaded: true,
      loading: false,
      error: null,
    });
    if (parent.relativePath) this.expanded.add(parent.relativePath);
    this.selectedPath = result.value.ref.relativePath;
    this.rootError = null;
    this.publish();
    await this.refreshAfterMutation(parent, result.value.name);
    return result;
  }

  async renameEntry(
    entry: DirectoryEntry,
    newName: string,
  ): Promise<ResultEnvelope<RenameEntryResult>> {
    const requestGeneration = this.generation;
    const result = await this.renameEntryAction({
      ref: entry.ref,
      newName,
      expectedRevision: entry.revision,
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) return result;
    if (requestGeneration !== this.generation || this.root?.grant.grantId !== entry.ref.grantId) {
      return result;
    }

    const parentPath = entry.ref.relativePath.split('/').slice(0, -1).join('/');
    const parent = this.records.get(parentPath);
    if (parent) {
      this.records.set(parentPath, {
        ...parent,
        items: parent.items
          .map(item => item.ref.relativePath === entry.ref.relativePath ? result.value.entry : item)
          .sort(compareEntries),
      });
    }

    const from = entry.ref.relativePath;
    const to = result.value.entry.ref.relativePath;
    const remap = (path: string) => path === from || path.startsWith(`${from}/`)
      ? `${to}${path.slice(from.length)}` : null;
    const remappedRecords = new Map<string, DirectoryRecord>();
    for (const [key, record] of this.records) {
      const nextKey = remap(key);
      if (nextKey === null) {
        remappedRecords.set(key, record);
        continue;
      }
      remappedRecords.set(nextKey, {
        ...record,
        items: record.items.map(item => {
          const itemPath = remap(item.ref.relativePath);
          return item === result.value.entry || itemPath === null ? item : {
            ...item,
            ref: { ...item.ref, relativePath: itemPath },
          };
        }),
      });
    }
    if (parentPath) remappedRecords.set(parentPath, this.records.get(parentPath) ?? emptyRecord());
    this.records.clear();
    for (const [key, record] of remappedRecords) this.records.set(key, record);
    const remappedExpanded = new Set<string>();
    for (const path of this.expanded) remappedExpanded.add(remap(path) ?? path);
    this.expanded.clear();
    for (const path of remappedExpanded) this.expanded.add(path);
    if (this.selectedPath) this.selectedPath = remap(this.selectedPath) ?? this.selectedPath;
    this.rootError = null;
    this.publish();
    await this.refreshAfterMutation(
      { grantId: entry.ref.grantId, relativePath: parentPath },
      result.value.entry.name,
    );
    return result;
  }

  private async refreshAfterMutation(directory: FileRef, changedName: string) {
    if (this.root?.grant.grantId !== directory.grantId) return;
    await this.load(directory, false);
    await this.findEntry(directory, changedName);
    await this.refreshParentEntry(directory);
  }

  private async refreshParentEntry(directory: FileRef) {
    if (this.root?.grant.grantId !== directory.grantId) return;
    if (!directory.relativePath) return;
    const segments = directory.relativePath.split('/').filter(Boolean);
    const ancestor = {
      grantId: directory.grantId,
      relativePath: segments.slice(0, -1).join('/'),
    };
    await this.load(ancestor, false);
    const directoryName = segments.at(-1);
    if (directoryName) await this.findEntry(ancestor, directoryName);
  }

  async reloadEntry(reference: FileRef): Promise<DirectoryEntry | null> {
    const generation = this.generation;
    const segments = reference.relativePath.split('/');
    const name = segments.pop();
    if (!name || this.root?.grant.grantId !== reference.grantId) return null;
    const parent = { grantId: reference.grantId, relativePath: segments.join('/') };
    this.refresh(parent);
    await this.ensureDirectory(parent);
    if (generation !== this.generation) return null;
    return await this.findEntry(parent, name) ?? null;
  }

  async trashEntry(request: TrashEntryRequest): Promise<ResultEnvelope<TrashEntryResult>> {
    const generation = this.generation;
    const result = await this.trashEntryAction(request);
    if (!result.ok) return result;
    const missing = result.value.missingDocumentIds;
    if (result.value.receiptId !== request.requestId || missing.length !== request.affectedDocumentIds.length
      || missing.some(id => !request.affectedDocumentIds.includes(id))
      || result.value.drafts.length !== request.snapshots.length
      || result.value.drafts.some(draft => !request.snapshots.some(snapshot =>
        snapshot.documentId === draft.documentId && snapshot.documentVersion === draft.documentVersion))) {
      return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '回收回执与原请求不匹配，结果尚未确认；请核对原请求。', retryable: false } };
    }
    if (generation !== this.generation || this.root?.grant.grantId !== request.ref.grantId) return result;
    const path = request.ref.relativePath;
    const parentPath = path.split('/').slice(0, -1).join('/');
    for (const key of this.records.keys()) if (isAtOrBelow(key, path)) this.records.delete(key);
    for (const key of this.expanded) if (isAtOrBelow(key, path)) this.expanded.delete(key);
    for (const key of this.requestVersions.keys()) if (key === parentPath || isAtOrBelow(key, path)) {
      this.requestVersions.set(key, (this.requestVersions.get(key) ?? 0) + 1);
    }
    const parent = this.records.get(parentPath);
    if (parent) this.records.set(parentPath, { ...parent, items: parent.items.filter(item => item.ref.relativePath !== path),
      loading: false, nextCursor: null });
    if (this.selectedPath && isAtOrBelow(this.selectedPath, path)) this.selectedPath = parentPath || null;
    this.publish();
    const reference = { grantId: request.ref.grantId, relativePath: parentPath };
    await this.load(reference, false);
    await this.refreshParentEntry(reference);
    return result;
  }

  async transferEntry(
    entry: DirectoryEntry,
    targetParent: FileRef,
    mode: TransferEntryRequest['mode'],
  ): Promise<ResultEnvelope<TransferEntryResult>> {
    const requestGeneration = this.generation;
    const result = await this.transferEntryAction({
      source: entry.ref,
      targetParent,
      mode,
      expectedRevision: entry.revision,
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) return result;
    if (requestGeneration !== this.generation) return result;
    const sourceParentPath = entry.ref.relativePath.split('/').slice(0, -1).join('/');
    const sourceParent = { grantId: entry.ref.grantId, relativePath: sourceParentPath };
    const destinationParent = { grantId: result.value.entry.ref.grantId,
      relativePath: result.value.entry.ref.relativePath.split('/').slice(0, -1).join('/') };
    if (mode === 'move') {
      this.applyTransferRemap(entry, result.value.entry);
      this.selectedPath = result.value.entry.ref.relativePath;
    } else {
      const record = this.records.get(destinationParent.relativePath) ?? emptyRecord();
      if (destinationParent.grantId === this.root?.grant.grantId) {
        this.records.set(destinationParent.relativePath, {
          ...record,
          items: [...record.items.filter(item => item.ref.relativePath !== result.value.entry.ref.relativePath),
            result.value.entry].sort(compareEntries),
          loaded: true,
          loading: false,
          error: null,
        });
      }
      this.selectedPath = result.value.entry.ref.relativePath;
    }
    this.rootError = null;
    this.publish();
    if (sourceParent.grantId === this.root?.grant.grantId) await this.load(sourceParent, false);
    if (destinationParent.grantId === this.root?.grant.grantId
      && destinationParent.relativePath !== sourceParent.relativePath) {
      await this.load(destinationParent, false);
    }
    return result;
  }

  private applyTransferRemap(source: DirectoryEntry, target: DirectoryEntry) {
    const from = source.ref.relativePath;
    const to = target.ref.relativePath;
    const remap = (path: string) => path === from || path.startsWith(`${from}/`)
      ? `${to}${path.slice(from.length)}` : null;
    const remapped = new Map<string, DirectoryRecord>();
    for (const [key, record] of this.records) {
      const nextKey = remap(key);
      const targetGrant = target.ref.grantId;
      remapped.set(nextKey ?? key, {
        ...record,
        items: record.items.flatMap(item => {
          const itemPath = remap(item.ref.relativePath);
          if (item.ref.relativePath === from) return [target];
          return itemPath === null ? [item] : [{ ...item, ref: { ...item.ref, grantId: targetGrant, relativePath: itemPath } }];
        }),
      });
    }
    this.records.clear();
    for (const [key, record] of remapped) this.records.set(key, record);
    const expanded = new Set<string>();
    for (const path of this.expanded) expanded.add(remap(path) ?? path);
    this.expanded.clear();
    for (const path of expanded) this.expanded.add(path);
    if (this.selectedPath) this.selectedPath = remap(this.selectedPath) ?? this.selectedPath;
  }

  async locate(reference: FileRef): Promise<boolean> {
    if (this.root?.grant.grantId !== reference.grantId && this.roots.some(root => root.grant.grantId === reference.grantId)) {
      this.activateRoot(reference.grantId);
    }
    if (!this.root || reference.grantId !== this.root.grant.grantId) {
      this.rootError = '当前文件不在已打开的文件夹中。';
      this.publish();
      return false;
    }
    const segments = reference.relativePath.split('/').filter(Boolean);
    if (segments.length === 0) return false;
    let parent = this.root.grant;
    for (let index = 0; index < segments.length; index++) {
      const record = await this.ensureDirectory(parent);
      if (!record) return false;
      const entry = await this.findEntry(parent, segments[index]!);
      if (!entry) {
        this.rootError = `无法定位“${reference.relativePath}”；目录可能已被外部修改。`;
        this.publish();
        return false;
      }
      if (index === segments.length - 1) {
        this.selectedPath = entry.ref.relativePath;
        this.rootError = null;
        this.publish();
        return true;
      }
      if (entry.kind !== 'directory') {
        this.rootError = '当前文件路径中的目录项已变为文件。';
        this.publish();
        return false;
      }
      parent = entry.ref;
      this.expanded.add(parent.relativePath);
      this.publish();
    }
    return false;
  }

  private async ensureDirectory(reference: FileRef): Promise<DirectoryRecord | null> {
    let record = this.records.get(reference.relativePath);
    if (!record?.loaded && !record?.loading) {
      const result = await this.load(reference, false);
      if (!result?.ok) return null;
      record = this.records.get(reference.relativePath);
    } else if (record?.loading) {
      await new Promise<void>(resolve => {
        const listener = () => {
          const latest = this.records.get(reference.relativePath);
          if (!latest?.loading) {
            this.listeners.delete(listener);
            resolve();
          }
        };
        this.listeners.add(listener);
      });
      record = this.records.get(reference.relativePath);
    }
    return record?.loaded ? record : null;
  }

  private async findEntry(parent: FileRef, name: string): Promise<DirectoryEntry | undefined> {
    let record = this.records.get(parent.relativePath);
    while (record) {
      const found = record.items.find(entry => entry.name === name);
      if (found || !record.nextCursor) return found;
      const result = await this.load(parent, true);
      if (!result?.ok) return undefined;
      record = this.records.get(parent.relativePath);
    }
    return undefined;
  }

  private async load(
    reference: FileRef,
    append: boolean,
  ): Promise<ResultEnvelope<DirectoryPage> | null> {
    const root = this.root;
    if (!root) return null;
    const key = reference.relativePath;
    const current = this.records.get(key) ?? emptyRecord();
    if (current.loading || (append && !current.nextCursor)) return null;
    const requestGeneration = this.generation;
    const requestVersion = (this.requestVersions.get(key) ?? 0) + 1;
    this.requestVersions.set(key, requestVersion);
    this.records.set(key, { ...current, loading: true, error: null });
    this.publish();
    const result = await this.listDirectory({
      ref: reference,
      ...(append && current.nextCursor ? { cursor: current.nextCursor } : {}),
      showHidden: this.showHidden,
    });
    if (requestGeneration !== this.generation
      || this.requestVersions.get(key) !== requestVersion) return null;
    const latest = this.records.get(key) ?? emptyRecord();
    if (!result.ok) {
      this.records.set(key, { ...latest, loading: false, error: result.error.message });
      this.publish();
      return result;
    }
    const existing = append ? latest.items : [];
    const seen = new Set(existing.map(item => item.ref.relativePath));
    const items = [...existing, ...result.value.items.filter(item => {
      if (seen.has(item.ref.relativePath)) return false;
      seen.add(item.ref.relativePath);
      return true;
    })];
    this.records.set(key, {
      items, nextCursor: result.value.nextCursor, loaded: true, loading: false, error: null,
    });
    this.publish();
    return result;
  }

  private publish() {
    this.snapshot = {
      root: this.root,
      roots: this.roots,
      records: Object.fromEntries(this.records),
      expanded: Object.fromEntries([...this.expanded].map(key => [key, true])),
      selectedPath: this.selectedPath,
      showHidden: this.showHidden,
      rootError: this.rootError,
      filters: this.filters,
      syncStatus: this.syncStatus,
    };
    this.listeners.forEach(listener => listener());
  }
}

export const workspace = new WorkspaceStore();

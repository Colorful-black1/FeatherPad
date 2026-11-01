import { files } from '../../bridge/files';
import type {
  CreateEntryRequest, DirectoryEntry, DirectoryPage, FileRef, ListDirectoryRequest,
  RenameEntryRequest, RenameEntryResult, ResultEnvelope,
} from '../../shared/contracts/files';

export interface WorkspaceRoot {
  grant: FileRef;
  displayName: string;
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
  records: Readonly<Record<string, DirectoryRecord>>;
  expanded: Readonly<Record<string, true>>;
  selectedPath: string | null;
  showHidden: boolean;
  rootError: string | null;
}

type ListDirectory = (request: ListDirectoryRequest) => Promise<ResultEnvelope<DirectoryPage>>;
type CreateEntry = (request: CreateEntryRequest) => Promise<ResultEnvelope<DirectoryEntry>>;
type RenameEntry = (request: RenameEntryRequest) => Promise<ResultEnvelope<RenameEntryResult>>;

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
  root: null, records: { '': emptyRecord() }, expanded: {}, selectedPath: null,
  showHidden: false, rootError: null,
});

export class WorkspaceStore {
  private readonly listDirectory: ListDirectory;
  private readonly createEntryAction: CreateEntry;
  private readonly renameEntryAction: RenameEntry;
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, DirectoryRecord>();
  private readonly expanded = new Set<string>();
  private readonly requestVersions = new Map<string, number>();
  private snapshot: WorkspaceSnapshot;
  private root: WorkspaceRoot | null = null;
  private showHidden = false;
  private selectedPath: string | null = null;
  private rootError: string | null = null;
  private generation = 0;

  constructor(
    listDirectory: ListDirectory = request => files.listDirectory(request),
    createEntry: CreateEntry = request => files.createEntry(request),
    renameEntry: RenameEntry = request => files.renameEntry(request),
  ) {
    this.listDirectory = listDirectory;
    this.createEntryAction = createEntry;
    this.renameEntryAction = renameEntry;
    this.records.set('', emptyRecord());
    this.snapshot = initialSnapshot();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  setRoot(root: WorkspaceRoot | null) {
    this.generation++;
    this.root = root;
    this.records.clear();
    this.expanded.clear();
    this.requestVersions.clear();
    this.selectedPath = null;
    this.rootError = null;
    this.records.set('', emptyRecord());
    this.publish();
    if (root) void this.load(root.grant, false);
  }

  clearRoot() {
    this.setRoot(null);
  }

  setShowHidden(showHidden: boolean) {
    if (this.showHidden === showHidden) return;
    this.generation++;
    this.showHidden = showHidden;
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

  async locate(reference: FileRef): Promise<boolean> {
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
      records: Object.fromEntries(this.records),
      expanded: Object.fromEntries([...this.expanded].map(key => [key, true])),
      selectedPath: this.selectedPath,
      showHidden: this.showHidden,
      rootError: this.rootError,
    };
    this.listeners.forEach(listener => listener());
  }
}

export const workspace = new WorkspaceStore();

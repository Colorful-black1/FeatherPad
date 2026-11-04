import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentId, LoadedRecoveryEntry, OpenDocument, OpenMode, ResultEnvelope, SessionClearResult,
  SessionLoadResult, SessionManifest, SessionSaveResult,
} from '../../shared/contracts/files';
import { DocumentRegistry } from '../editor/documents';
import { TabController } from '../editor/tabs';
import { SaveCoordinator } from '../editor/save';
import { CloseCoordinator } from '../editor/close';
import { WorkspaceStore, type WorkspaceSnapshot } from '../workspace/store';
import { SessionCoordinator } from './session';

function recovered(id: DocumentId, version: number, receiptId = crypto.randomUUID(),
  text = `draft ${version}`): LoadedRecoveryEntry {
  return {
    entry: {
      receiptId,
      reason: 'periodic',
      documentId: id,
      bufferVersion: version,
      sourcePath: null,
      sourceRevision: null,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
      newlineMap: { documentVersion: version, endings: [] },
      bodyBytes: new TextEncoder().encode(text).byteLength,
      bodySha256: 'a'.repeat(64),
      createdAt: `2026-11-02T00:0${version}:00.000Z`,
    },
    text,
  };
}

function clean(id: DocumentId, name = 'clean.txt'): OpenDocument {
  return {
    documentId: id,
    ref: { grantId: `grant-${id}` as OpenDocument['ref']['grantId'], relativePath: '' },
    metadata: {
      displayPath: `E:\\fixtures\\${name}`,
      sizeBytes: 5,
      modifiedAt: '2026-11-02T00:00:00.000Z',
      isReadOnly: false,
      diskRevision: 'b'.repeat(64) as OpenDocument['metadata']['diskRevision'],
    },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
    warnings: [],
    mode: 'normal',
    content: { kind: 'text', text: 'clean', newlineMap: { documentVersion: 0, endings: [] } },
  };
}

function tabsFor(registry: DocumentRegistry) {
  const saves = new SaveCoordinator(registry);
  const closes = new CloseCoordinator(registry, saves);
  return new TabController(registry, closes, async () => ({
    ok: true,
    value: clean(crypto.randomUUID() as DocumentId),
  }), null);
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    root: null,
    roots: [],
    records: {},
    expanded: {},
    selectedPath: null,
    showHidden: false,
    rootError: null,
    filters: { include: [], exclude: [], respectGitignore: true, followDirectoryLinks: false },
    syncStatus: { kind: 'ready', message: null },
  };
}

function workspaceStore() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: workspaceSnapshot,
    setRoot: vi.fn(),
    addRoot: vi.fn(),
  };
}

it('restores and persists all roots while retaining unavailable root placeholders', async () => {
  const registry = new DocumentRegistry(), tabs = tabsFor(registry);
  const workspace = new WorkspaceStore(async () => ({ ok: true, value: { items: [], nextCursor: null } }));
  const saved: SessionManifest[] = [];
  const coordinator = new SessionCoordinator(registry, tabs, workspace,
    async manifest => { saved.push(manifest); return { ok: true, value: { saved: true, persistedAt: manifest.persistedAt } }; });
  const rootIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const manifest: SessionManifest = { schemaVersion: 1, sessionId: crypto.randomUUID(), recoverySnapshotRefs: [], persistedAt: '2026-11-03T00:00:00Z',
    windows: [{ windowId: 'main', bounds: { x: 0, y: 0, width: 1200, height: 800 }, rootIds, rootLabels: ['first', 'second', 'missing'],
      activeViewId: null, groups: [{ groupId: 'primary', viewIds: [] }], views: [] }] };
  await coordinator.restoreSources(manifest, rootIds.slice(0, 2));
  coordinator.apply(manifest);
  expect(workspace.getSnapshot().roots.map(root => root.grant.grantId)).toEqual(rootIds.slice(0, 2));
  expect(coordinator.getSnapshot().missingSources).toContainEqual({ id: rootIds[2], title: 'missing', kind: 'workspace' });
  await coordinator.flush();
  expect(saved[0]?.windows[0]?.rootIds).toEqual(rootIds);
  coordinator.stop();
});

function fixture(options: {
  windowId?: string;
  save?: (manifest: SessionManifest) => Promise<ResultEnvelope<SessionSaveResult>>;
  open?: (ref: OpenDocument['ref'], mode?: Exclude<OpenMode, 'normal'>, documentId?: DocumentId)
    => Promise<ResultEnvelope<OpenDocument>>;
} = {}) {
  const registry = new DocumentRegistry();
  const tabs = tabsFor(registry);
  const workspaceStoreMock = workspaceStore();
  const save = vi.fn(options.save ?? (async manifest => ({
    ok: true as const,
    value: { saved: true as const, persistedAt: manifest.persistedAt },
  })));
  const open = vi.fn(options.open ?? (async () => ({
    ok: false as const,
    error: { code: 'IPC_UNAVAILABLE' as const, message: 'test open transport is not configured', retryable: false },
  })));
  const coordinator = new SessionCoordinator(
    registry,
    tabs,
    workspaceStoreMock,
    save,
    async (): Promise<ResultEnvelope<SessionLoadResult>> => ({
      ok: true,
      value: { session: null, warning: null, restoredGrantIds: [] },
    }),
    async (): Promise<ResultEnvelope<SessionClearResult>> => ({ ok: true, value: { cleared: true } }),
    open,
    undefined,
    options.windowId,
  );
  return { registry, tabs, save, open, workspaceStore: workspaceStoreMock, coordinator };
}

describe('SessionCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a newly created window empty instead of cloning another window session', async () => {
    const h = fixture({ windowId: `window-${crypto.randomUUID()}` });
    const manifest: SessionManifest = { schemaVersion: 1, sessionId: crypto.randomUUID(), recoverySnapshotRefs: [], persistedAt: '2026-11-04T00:00:00Z',
      windows: [{ windowId: 'main', bounds: { x: 0, y: 0, width: 1200, height: 800 }, rootIds: [crypto.randomUUID()], rootLabels: ['main root'],
        activeViewId: null, groups: [{ groupId: 'primary', viewIds: [] }], views: [] }] };
    const restored = await h.coordinator.restoreSources(manifest, manifest.windows[0]!.rootIds);
    expect(restored.sources.size).toBe(0);
    expect(h.workspaceStore.setRoot).not.toHaveBeenCalled();
    expect(h.coordinator.apply(manifest)).toEqual({ applied: 0, missing: 0, warnings: [] });
    expect(h.registry.getSnapshot().documents).toEqual([]);
    h.coordinator.stop();
  });

  it('restores the source disk encoding independently of an unsaved target conversion', async () => {
    const id = crypto.randomUUID() as DocumentId;
    const base = clean(id, 'legacy.txt');
    const source: OpenDocument = { ...base, format: { ...base.format, encoding: 'gbk' } };
    const h = fixture(); h.registry.openDocument(source);
    expect(h.registry.changeFormat(id, 0, { ...base.format, encoding: 'utf-8' })).toMatchObject({ ok: true });
    h.registry.acknowledgeRecovery(id, 1, crypto.randomUUID());
    await h.coordinator.flush();
    const manifest = h.save.mock.calls[0]![0];
    expect(manifest.windows[0]!.views[0]).toMatchObject({ encodingOverride: 'gbk', dirty: true, bufferVersion: 1 });
    const next = fixture({ open: async () => ({ ok: true, value: source }) });
    const restored = await next.coordinator.restoreSources(manifest, [source.ref.grantId]);
    expect(next.open).toHaveBeenCalledWith(source.ref, undefined, id, 'gbk');
    expect(restored.sources.get(id)?.format.encoding).toBe('gbk');
  });

  it('restores verified receipt tabs, order, active view, cursor and scroll', () => {
    const h = fixture();
    const first = crypto.randomUUID() as DocumentId;
    const second = crypto.randomUUID() as DocumentId;
    const preview = crypto.randomUUID() as DocumentId;
    const firstReceipt = crypto.randomUUID();
    const secondReceipt = crypto.randomUUID();
    h.registry.openRecovered(recovered(second, 4, secondReceipt));
    h.registry.openRecovered(recovered(first, 3, firstReceipt));
    h.registry.openDocument(clean(preview));
    const sessionId = crypto.randomUUID();
    const manifest: SessionManifest = {
      schemaVersion: 1,
      sessionId,
      windows: [{
        windowId: 'main',
        bounds: { x: 20, y: 30, width: 1200, height: 800 },
        rootIds: [],
        rootLabels: [],
        activeViewId: second,
        groups: [{ groupId: 'primary', viewIds: [first, second, preview] }],
        views: [
          { viewId: first, bufferVersion: 3, documentId: first, recoveryReceiptId: firstReceipt, title: 'first.txt',
            fileRef: null, diskRevision: null, openMode: 'normal',
            displayPath: null, isPreview: false, dirty: true, selection: [{ anchor: 1, head: 3 }], scrollAnchor: 120 },
          { viewId: second, bufferVersion: 4, documentId: second, recoveryReceiptId: secondReceipt, title: 'second.txt',
            fileRef: null, diskRevision: null, openMode: 'normal',
            displayPath: null, isPreview: false, dirty: true, selection: [{ anchor: 2, head: 2 }], scrollAnchor: 240 },
          { viewId: preview, bufferVersion: 0, documentId: preview, recoveryReceiptId: null, title: 'clean.txt',
            fileRef: clean(preview).ref, diskRevision: clean(preview).metadata.diskRevision,
            openMode: 'normal',
            displayPath: 'E:\\fixtures\\clean.txt', isPreview: true, dirty: false,
            selection: [{ anchor: 0, head: 5 }], scrollAnchor: 0 },
        ],
      }],
      recoverySnapshotRefs: [firstReceipt, secondReceipt],
      persistedAt: '2026-11-02T00:00:00.000Z',
    };

    expect(h.coordinator.apply(manifest)).toEqual({ applied: 3, missing: 0, warnings: [] });
    expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual([first, second, preview]);
    expect(h.registry.getSnapshot().activeId).toBe(second);
    expect(h.registry.getDocument(first)?.state.selection.main).toMatchObject({ anchor: 1, head: 3 });
    expect(h.registry.getDocument(second)?.scroll.top).toBe(240);
    expect(h.tabs.getSnapshot().previewId).toBe(preview);
  });

  it.each(['head-preview', 'text-preview'] as const)('restores an authorized workspace and %s with stable identity and mode', async mode => {
    const id = crypto.randomUUID() as DocumentId;
    const rootId = crypto.randomUUID();
    const base = clean(id, 'large.txt');
    const source: OpenDocument = {
      ...base,
      mode,
      metadata: { ...base.metadata, sizeBytes: 120 * 1024 * 1024 },
      content: {
        kind: 'head',
        text: 'clean',
        previewBytes: 5,
        totalBytes: 120 * 1024 * 1024,
        truncated: true,
      },
    };
    const h = fixture({
      open: async (ref, mode, documentId) => {
        expect(ref).toEqual(base.ref);
        expect(mode).toBe(source.mode);
        expect(documentId).toBe(id);
        return { ok: true, value: source };
      },
    });
    const manifest: SessionManifest = {
      schemaVersion: 1,
      sessionId: crypto.randomUUID(),
      windows: [{
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        rootIds: [rootId],
        rootLabels: ['受控工作区'],
        activeViewId: id,
        groups: [{ groupId: 'primary', viewIds: [id] }],
        views: [{
          viewId: id,
          bufferVersion: 0,
          documentId: id,
          recoveryReceiptId: null,
          fileRef: base.ref,
          diskRevision: base.metadata.diskRevision,
          openMode: mode,
          title: 'large.txt',
          displayPath: base.metadata.displayPath,
          isPreview: false,
          dirty: false,
          selection: [{ anchor: 0, head: 0 }],
          scrollAnchor: 0,
        }],
      }],
      recoverySnapshotRefs: [],
      persistedAt: '2026-11-02T00:00:00.000Z',
    };

    const restored = await h.coordinator.restoreSources(manifest, [rootId, base.ref.grantId]);
    expect(restored.warnings).toEqual([]);
    expect(restored.sources.get(id)).toBe(source);
    expect(h.workspaceStore.setRoot).toHaveBeenCalledWith({
      grant: { grantId: rootId, relativePath: '' },
      displayName: '受控工作区',
    });
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.registry.getSnapshot().documents.map(document => document.id)).toEqual([id]);
    manifest.windows[0]!.views[0]!.bufferVersion = 11;
    h.coordinator.apply(manifest);
    await h.coordinator.flush();
    expect(h.registry.getDocument(id)?.summary.version).toBe(11);
    expect(h.save.mock.calls[0]?.[0].windows[0]?.views[0]?.bufferVersion).toBe(11);
    expect(h.save.mock.calls[0]?.[0].windows[0]?.views[0]?.openMode).toBe(mode);
  });

  it('keeps unauthorized roots and files missing without opening an arbitrary path', async () => {
    const id = crypto.randomUUID() as DocumentId;
    const rootId = crypto.randomUUID();
    const base = clean(id);
    const h = fixture();
    const manifest: SessionManifest = {
      schemaVersion: 1,
      sessionId: crypto.randomUUID(),
      windows: [{
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        rootIds: [rootId],
        rootLabels: ['失效工作区'],
        activeViewId: id,
        groups: [{ groupId: 'primary', viewIds: [id] }],
        views: [{
          viewId: id,
          bufferVersion: 0,
          documentId: id,
          recoveryReceiptId: null,
          fileRef: base.ref,
          diskRevision: base.metadata.diskRevision,
          openMode: 'normal',
          title: 'clean.txt',
          displayPath: base.metadata.displayPath,
          isPreview: false,
          dirty: false,
          selection: [{ anchor: 0, head: 0 }],
          scrollAnchor: 0,
        }],
      }],
      recoverySnapshotRefs: [],
      persistedAt: '2026-11-02T00:00:00.000Z',
    };

    const restored = await h.coordinator.restoreSources(manifest, []);
    expect(restored.sources.size).toBe(0);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.workspaceStore.setRoot).not.toHaveBeenCalled();
    expect(restored.warnings.join(' ')).toContain('失效工作区');
    expect(restored.warnings.join(' ')).toContain('clean.txt');
    h.coordinator.apply(manifest);
    expect(h.coordinator.getSnapshot().missingSources).toEqual([
      { id: rootId, title: '失效工作区', kind: 'workspace' },
      { id, title: 'clean.txt', kind: 'file' },
    ]);
    await h.coordinator.flush();
    expect(h.save.mock.calls[0]?.[0].windows[0]).toMatchObject({
      rootIds: [rootId], views: [{ documentId: id }],
    });
    h.coordinator.forgetMissing(rootId);
    h.coordinator.forgetMissing(id);
    await h.coordinator.flush();
    expect(h.save.mock.calls[1]?.[0].windows[0]).toMatchObject({ rootIds: [], views: [] });
    expect(h.coordinator.getSnapshot().missingSources).toEqual([]);
    expect(h.registry.getSnapshot().documents).toHaveLength(0);
  });

  it('rejects a dirty view when its receipt is missing or does not match the restored buffer', () => {
    const h = fixture();
    const first = crypto.randomUUID() as DocumentId;
    const second = crypto.randomUUID() as DocumentId;
    const missing = crypto.randomUUID() as DocumentId;
    const firstReceipt = crypto.randomUUID();
    const secondReceipt = crypto.randomUUID();
    const wrongReceipt = crypto.randomUUID();
    h.registry.openRecovered(recovered(first, 1, firstReceipt));
    h.registry.openRecovered(recovered(second, 2, secondReceipt));
    const manifest: SessionManifest = {
      schemaVersion: 1,
      sessionId: crypto.randomUUID(),
      windows: [{
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        rootIds: ['17ef5e8f-1152-4f81-9212-0df486aa1144'],
        rootLabels: ['saved-root'],
        activeViewId: first,
        groups: [{ groupId: 'primary', viewIds: [first, second, missing] }],
        views: [
          { viewId: first, bufferVersion: 1, documentId: first, recoveryReceiptId: wrongReceipt, title: 'first.txt',
            fileRef: null, diskRevision: null, openMode: 'normal',
            displayPath: null, isPreview: false, dirty: true, selection: [{ anchor: 0, head: 0 }], scrollAnchor: 0 },
          { viewId: second, bufferVersion: 2, documentId: second, recoveryReceiptId: secondReceipt, title: 'second.txt',
            fileRef: null, diskRevision: null, openMode: 'normal',
            displayPath: null, isPreview: false, dirty: true, selection: [{ anchor: 0, head: 0 }], scrollAnchor: 0 },
          { viewId: missing, bufferVersion: 0, documentId: missing, recoveryReceiptId: null, title: 'missing.txt',
            fileRef: null, diskRevision: null, openMode: 'normal',
            displayPath: null, isPreview: false, dirty: false, selection: [{ anchor: 0, head: 0 }], scrollAnchor: 0 },
        ],
      }],
      recoverySnapshotRefs: [wrongReceipt, secondReceipt],
      persistedAt: '2026-11-02T00:00:00.000Z',
    };

    const result = h.coordinator.apply(manifest);
    expect(result.applied).toBe(1);
    expect(result.missing).toBe(2);
    expect(result.warnings.join(' ')).toContain('交叉校验');
    expect(h.registry.getSnapshot().activeId).toBe(second);
    expect(h.registry.getDocument(second)?.state.selection.main.head).toBe(0);
  });

  it('captures only a receipt that protects the current dirty version', async () => {
    const h = fixture();
    const id = crypto.randomUUID() as DocumentId;
    const receiptId = crypto.randomUUID();
    h.registry.openRecovered(recovered(id, 2, receiptId, 'current draft'));
    const first = await h.coordinator.flush();
    expect(first.ok).toBe(true);
    const saved = h.save.mock.calls[0]?.[0];
    expect(saved?.recoverySnapshotRefs).toEqual([receiptId]);
    expect(saved?.windows[0]?.views[0]).toMatchObject({ recoveryReceiptId: receiptId, dirty: true });

    const document = h.registry.getDocument(id)!;
    h.registry.commit(id, [document.state.update({ changes: { from: document.state.doc.length, insert: ' newer' } })]);
    await h.coordinator.flush();
    const newer = h.save.mock.calls[1]?.[0];
    expect(newer?.recoverySnapshotRefs).toEqual([]);
    expect(newer?.windows[0]?.views[0]).toMatchObject({ recoveryReceiptId: null, dirty: true });
  });

  it('captures content dimensions so restoring does not repeatedly add the window frame', async () => {
    vi.stubGlobal('window', { screenX: 100, screenY: 80, innerWidth: 1100, innerHeight: 700,
      outerWidth: 1116, outerHeight: 739 });
    try {
      const h = fixture();
      await h.coordinator.flush();
      expect(h.save.mock.calls[0]?.[0].windows[0]?.bounds)
        .toEqual({ x: 100, y: 80, width: 1100, height: 700 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('debounces state changes and retains the failure for the exit flow to handle', async () => {
    vi.useFakeTimers();
    const failure = {
      ok: false as const,
      error: { code: 'DISK_FULL' as const, message: 'controlled session storage full', retryable: false },
    };
    const h = fixture({ save: async () => failure });
    const stop = h.coordinator.start();
    try {
      h.registry.openRecovered(recovered(crypto.randomUUID() as DocumentId, 1));
      await vi.advanceTimersByTimeAsync(999);
      expect(h.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.save).toHaveBeenCalledTimes(1);
      expect(h.coordinator.getSnapshot()).toMatchObject({ phase: 'failed' });
    } finally {
      stop();
    }
  });
});

import { expect, it, vi } from 'vitest';
import type { DocumentId, LoadedRecoveryEntry, OpenDocument, RecoveryEntry, ResultEnvelope, SessionManifest } from '../../shared/contracts/files';
import { DocumentRegistry } from '../editor/documents';
import { RecoveryStartup } from './recovery-startup';

function entry(id: DocumentId, version: number, createdAt: string, sourcePath: string | null = null): RecoveryEntry {
  return {
    receiptId: crypto.randomUUID(),
    reason: 'periodic',
    documentId: id,
    bufferVersion: version,
    sourcePath,
    sourceRevision: sourcePath ? 'a'.repeat(64) as RecoveryEntry['sourceRevision'] : null,
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
    newlineMap: { documentVersion: version, endings: ['lf'] },
    bodyBytes: 6,
    bodySha256: 'b'.repeat(64),
    createdAt,
  };
}

function loaded(item: RecoveryEntry, text = 'draft\n'): LoadedRecoveryEntry {
  return { entry: item, text };
}

it('restores the newest valid recovery copy, falls back from a damaged receipt and keeps source unbound', async () => {
  const firstId = crypto.randomUUID() as DocumentId;
  const secondId = crypto.randomUUID() as DocumentId;
  const older = entry(firstId, 1, '2026-11-02T00:00:00Z', 'E:\\fixtures\\first.txt');
  const damagedLatest = entry(firstId, 2, '2026-11-02T00:01:00Z', 'E:\\fixtures\\first.txt');
  const second = entry(secondId, 3, '2026-11-02T00:02:00Z');
  const list = vi.fn(async () => ({ ok: true as const, value: {
    entries: [damagedLatest, older, second],
    failures: [{ entryId: crypto.randomUUID(), message: '一个损坏副本已隔离。' }],
    startupWarnings: ['一个未确认保存事务已保留。'],
    storageBytes: 4096,
    saveTransactions: [],
  } }));
  const load = vi.fn(async ({ receiptId }: { receiptId: string }): Promise<ResultEnvelope<LoadedRecoveryEntry>> => {
    if (receiptId === damagedLatest.receiptId) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '最新副本损坏。', retryable: false } };
    }
    const item = receiptId === older.receiptId ? older : second;
    return { ok: true, value: loaded(item) };
  });
  const registry = new DocumentRegistry();
  const startup = new RecoveryStartup(registry, list, load);
  const result = await startup.restore();
  expect(result).toMatchObject({ ok: true, value: {
    restored: [firstId, secondId], corruptEntries: 2,
  } });
  expect(result.ok && result.value.warnings).toContain('一个未确认保存事务已保留。');
  expect(registry.getSnapshot().documents).toHaveLength(2);
  expect(registry.getDocument(firstId)?.summary).toMatchObject({
    version: 1, dirty: true, recovered: true, recoveryProtected: true,
    displayPath: 'E:\\fixtures\\first.txt', readOnlyReason: null,
  });
  expect(registry.getDocument(firstId)?.source).toBeNull();
  expect(registry.getDocument(firstId)?.state.doc.toString()).toBe('draft\n');
  expect(registry.getSnapshot().activeId).toBe(secondId);
});

it('returns the list failure without opening or overwriting an existing buffer', async () => {
  const registry = new DocumentRegistry();
  const startup = new RecoveryStartup(registry,
    async () => ({ ok: false, error: { code: 'IPC_UNAVAILABLE', message: 'offline', retryable: true } }),
    vi.fn());
  expect(await startup.restore()).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  expect(registry.getSnapshot().documents).toHaveLength(0);
});

it('warns about recovery copies older than 30 days without removing them', async () => {
  const id = crypto.randomUUID() as DocumentId;
  const old = entry(id, 1, '2026-09-01T00:00:00Z');
  const registry = new DocumentRegistry();
  const startup = new RecoveryStartup(registry,
    async () => ({ ok: true, value: {
      entries: [old], failures: [], startupWarnings: [], storageBytes: 128, saveTransactions: [],
    } }),
    async () => ({ ok: true, value: loaded(old) }));
  const result = await startup.restore();
  expect(result.ok && result.value.warnings.join(' ')).toContain('超过30天');
  expect(registry.getDocument(id)?.state.doc.toString()).toBe('draft\n');
});

it.each(['older', 'newer', 'source-missing'] as const)(
  'uses the clean session version without suppressing newer or unbound snapshots: %s', async mode => {
    const id = crypto.randomUUID() as DocumentId;
    const recovered = entry(id, mode === 'newer' ? 4 : 1, '2026-11-02T00:00:00Z', 'E:\\fixtures\\source.txt');
    const source: OpenDocument = {
      documentId: id, ref: { grantId: crypto.randomUUID() as OpenDocument['ref']['grantId'], relativePath: '' },
      metadata: { displayPath: 'E:\\fixtures\\source.txt', sizeBytes: 5, modifiedAt: '2026-11-02T00:00:00Z',
        isReadOnly: false, diskRevision: 'b'.repeat(64) as OpenDocument['metadata']['diskRevision'] },
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
      content: { kind: 'text', text: 'disk\n', newlineMap: { documentVersion: 0, endings: ['lf'] } },
    };
    const session: SessionManifest = {
      schemaVersion: 1, sessionId: crypto.randomUUID(), persistedAt: '2026-11-02T00:00:00Z',
      recoverySnapshotRefs: [], windows: [{
        windowId: 'main', bounds: { x: 0, y: 0, width: 1200, height: 800 }, rootIds: [], rootLabels: [],
        activeViewId: id, groups: [{ groupId: 'primary', viewIds: [id] }], views: [{
          viewId: id, documentId: id, bufferVersion: 3, recoveryReceiptId: null,
          fileRef: source.ref, diskRevision: source.metadata.diskRevision, openMode: 'normal',
          title: 'source.txt', displayPath: source.metadata.displayPath, isPreview: false, dirty: false,
          selection: [{ anchor: 0, head: 0 }], scrollAnchor: 0,
        }],
      }],
    };
    const registry = new DocumentRegistry();
    const load = vi.fn(async () => ({ ok: true as const, value: loaded(recovered) }));
    const startup = new RecoveryStartup(registry,
      async () => ({ ok: true, value: { entries: [recovered], failures: [], startupWarnings: [],
        storageBytes: 128, saveTransactions: [] } }), load);
    const sources = new Map<DocumentId, OpenDocument>();
    if (mode !== 'source-missing') { sources.set(id, source); registry.openDocument(source); }
    expect((await startup.restore(sources, session)).ok).toBe(true);
    if (mode === 'older') {
      expect(load).not.toHaveBeenCalled();
      expect(registry.getDocument(id)?.state.doc.toString()).toBe('disk\n');
      expect(registry.getDocument(id)?.summary.dirty).toBe(false);
    } else {
      expect(registry.getDocument(id)?.state.doc.toString()).toBe('draft\n');
      expect(registry.getDocument(id)?.summary.dirty).toBe(true);
      if (mode === 'newer') {
        expect(registry.getDocument(id)?.summary.readOnlyReason).toContain('磁盘内容');
        expect(source.content.text).toBe('disk\n');
        expect(registry.getDocument(id)?.savedText.toString()).toBe('disk\n');
      } else expect(registry.getDocument(id)?.source).toBeNull();
    }
  },
);


it('restores only this window drafts and leaves unassigned recovery to the primary host', async () => {
  const mainId = crypto.randomUUID() as DocumentId, secondId = crypto.randomUUID() as DocumentId;
  const orphanId = crypto.randomUUID() as DocumentId, secondWindow = `window-${crypto.randomUUID()}`;
  const entries = [mainId, secondId, orphanId].map(id => entry(id, 1, '2026-11-04T00:00:00Z'));
  const manifest: SessionManifest = { schemaVersion: 1, sessionId: crypto.randomUUID(), recoverySnapshotRefs: [], persistedAt: '2026-11-04T00:00:00Z',
    windows: [mainId, secondId].map((id, index) => ({
      windowId: index === 0 ? 'main' : secondWindow, bounds: { x: 0, y: 0, width: 1200, height: 800 }, rootIds: [], rootLabels: [],
      activeViewId: id, groups: [{ groupId: 'primary', viewIds: [id] }], views: [{
        viewId: id, documentId: id, bufferVersion: 1, recoveryReceiptId: entries[index]!.receiptId,
        fileRef: null, diskRevision: null, openMode: 'normal', title: 'draft', displayPath: null,
        isPreview: false, dirty: true, selection: [{ anchor: 0, head: 0 }], scrollAnchor: 0,
      }],
    })) };
  for (const [windowId, expected] of [['main', [mainId, orphanId]], [secondWindow, [secondId]], [`window-${crypto.randomUUID()}`, []]] as const) {
    const registry = new DocumentRegistry();
    const startup = new RecoveryStartup(registry,
      async () => ({ ok: true, value: { entries, failures: [], startupWarnings: [], storageBytes: 128, saveTransactions: [] } }),
      async request => ({ ok: true, value: loaded(entries.find(item => item.receiptId === request.receiptId)!) }));
    const result = await startup.restore(new Map(), manifest, windowId);
    expect(result.ok && result.value.restored).toEqual(expected);
    expect(registry.getSnapshot().documents.map(document => document.id)).toEqual(expected);
  }
});

import { expect, it } from 'vitest';
import { isOpenDocument } from '../../bridge/files';
import type { DiskRevision, ResultEnvelope, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { SaveCoordinator } from './save';

function opened() {
  const document: unknown = {
    documentId: 'save-fixture', ref: { grantId: 'fixture', relativePath: '' },
    metadata: { displayPath: 'fixture.txt', sizeBytes: 3, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'rev-0' },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'old', newlineMap: { documentVersion: 0, endings: [] } },
  };
  if (!isOpenDocument(document)) throw new Error('Invalid fixture');
  const registry = new DocumentRegistry();
  return { registry, id: registry.openDocument(document) };
}
function ack(version: number, revision: string): ResultEnvelope<SaveAck> {
  return { ok: true, value: { documentVersion: version, diskRevision: revision as DiskRevision, savedAt: '2026-11-01T00:00:00Z', sizeBytes: 8 } };
}

it('serializes saves and captures the newer text against the preceding Ack revision', async () => {
  const { registry, id } = opened();
  const requests: SaveRequest[] = [];
  const completions: ((result: ResultEnvelope<SaveAck>) => void)[] = [];
  const coordinator = new SaveCoordinator(registry, request => { requests.push(request); return new Promise(resolve => completions.push(resolve)); });
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, to: 3, insert: 'first' } })]);
  const first = coordinator.save(id);
  await Promise.resolve();
  const edited = registry.getDocument(id)!.state;
  registry.commit(id, [edited.update({ changes: { from: 0, to: 5, insert: 'second' } })]);
  const second = coordinator.save(id);
  expect(requests).toHaveLength(1);
  completions[0]!(ack(1, 'rev-1'));
  expect((await first).ok).toBe(true);
  await Promise.resolve();
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
  expect(requests[1]).toMatchObject({ text: 'second', documentVersion: 2, expectedDiskRevision: 'rev-1' });
  expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  completions[1]!(ack(2, 'rev-2'));
  expect((await second).ok).toBe(true);
  expect(registry.getDocument(id)!.summary.dirty).toBe(false);
});

it('does not automatically run queued writes after a failed save', async () => {
  const { registry, id } = opened();
  let calls = 0;
  const error: ResultEnvelope<SaveAck> = { ok: false, error: { code: 'DISK_FULL', message: 'Controlled full disk', retryable: false } };
  const coordinator = new SaveCoordinator(registry, async () => { calls++; return error; });
  const first = coordinator.save(id);
  const queued = coordinator.save(id);
  expect(await first).toEqual(error);
  expect(await queued).toEqual(error);
  expect(calls).toBe(1);
});

it('checks disk before retrying an unknown outcome and never overwrites a changed revision', async () => {
  const { registry, id } = opened();
  let writes = 0;
  let stats = 0;
  const coordinator = new SaveCoordinator(registry, async () => { writes++; throw new Error('sensitive fixture details'); }, async () => {
    stats++;
    return { ok: true, value: { displayPath: 'fixture.txt', sizeBytes: 8, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'external' as DiskRevision } };
  });
  expect(await coordinator.save(id)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  expect(await coordinator.save(id)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(writes).toBe(1);
  expect(stats).toBe(1);
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe('rev-0');
});

function destination(request: SaveAsRequest): ResultEnvelope<SaveAsAck> {
  const { registry, id } = opened();
  const source = registry.getDocument(id)!.source!;
  const saved: SaveAck = { documentVersion: request.documentVersion, diskRevision: 'as-rev-1' as DiskRevision, sizeBytes: 12, savedAt: '2026-11-01T00:00:00Z' };
  return { ok: true, value: { documentId: request.documentId, ref: source.ref,
    metadata: { ...source.metadata, displayPath: '新文件.txt', diskRevision: saved.diskRevision, sizeBytes: saved.sizeBytes }, ack: saved } };
}

it('routes untitled CtrlS to save-as and cancellation leaves the draft intact', async () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  const state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'unsaved draft' } })]);
  let calls = 0;
  const coordinator = new SaveCoordinator(registry, undefined, undefined, async request => {
    calls++;
    return calls === 1 ? { ok: false, error: { code: 'CANCELLED', message: 'controlled cancel', retryable: false } } : destination(request);
  });
  expect(await coordinator.save(id)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(registry.getDocument(id)!.source).toBeNull();
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('unsaved draft');
  expect(registry.getDocument(id)!.summary.dirty).toBe(true);
  expect((await coordinator.save(id)).ok).toBe(true);
  expect(registry.getDocument(id)!.summary).toMatchObject({ title: '新文件.txt', dirty: false });
  expect(calls).toBe(2);
});

it('copy succeeds without changing the source binding, dirty state or editor state', async () => {
  const { registry, id } = opened();
  const original = registry.getDocument(id)!.state;
  registry.commit(id, [original.update({ changes: { from: 0, insert: 'copy ' } })]);
  const before = registry.getDocument(id)!.state;
  const coordinator = new SaveCoordinator(registry, undefined, undefined, async request => {
    expect(request.intent).toBe('copy');
    return destination(request);
  });
  expect((await coordinator.saveAs(id, 'copy')).ok).toBe(true);
  expect(registry.getDocument(id)!.state).toBe(before);
  expect(registry.getDocument(id)!.summary).toMatchObject({ title: 'fixture.txt', dirty: true });
  expect(registry.getDocument(id)!.source?.metadata.diskRevision).toBe('rev-0');
});

it('retries an unknown save-as with the same request before saving later input', async () => {
  const registry = new DocumentRegistry();
  const id = registry.createUntitled();
  let state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: 0, insert: 'first' } })]);
  const requests: SaveAsRequest[] = [];
  const writes: SaveRequest[] = [];
  const coordinator = new SaveCoordinator(registry, async request => { writes.push(request); return ack(request.documentVersion, 'rev-final'); }, undefined,
    async request => { requests.push(request); if (requests.length === 1) throw new Error('controlled lost reply'); return destination(request); });
  expect(await coordinator.save(id)).toMatchObject({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
  state = registry.getDocument(id)!.state;
  registry.commit(id, [state.update({ changes: { from: state.doc.length, insert: ' newer' } })]);
  expect((await coordinator.save(id)).ok).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.requestId).toBe(requests[0]?.requestId);
  expect(requests[1]?.text).toBe('first');
  expect(writes[0]).toMatchObject({ text: 'first newer', expectedDiskRevision: 'as-rev-1' });
  expect(registry.getDocument(id)!.summary.dirty).toBe(false);
});

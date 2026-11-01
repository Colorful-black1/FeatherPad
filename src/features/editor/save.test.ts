import { expect, it } from 'vitest';
import { isOpenDocument } from '../../bridge/files';
import type { DiskRevision, ResultEnvelope, SaveAck, SaveRequest } from '../../shared/contracts/files';
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

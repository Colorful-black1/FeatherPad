import { afterEach, expect, it, vi } from 'vitest';
import { isOpenDocument } from '../../bridge/files';
import type { DiskRevision, DocumentId, ResultEnvelope, SaveAck, SaveRequest } from '../../shared/contracts/files';
import { SettingsCoordinator } from '../desktop/settings';
import { AutoSaveCoordinator } from './autosave';
import { DocumentRegistry } from './documents';
import type { ExternalStatus } from './external-changes';
import { SaveCoordinator } from './save';

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

function setup(transport?: (request: SaveRequest) => Promise<ResultEnvelope<SaveAck>>) {
  vi.useFakeTimers();
  const registry = new DocumentRegistry();
  const opened: unknown = { documentId: 'auto-fixture', ref: { grantId: 'fixture', relativePath: '' },
    metadata: { displayPath: 'fixture.txt', sizeBytes: 3, modifiedAt: '2026-11-01T00:00:00Z', isReadOnly: false, diskRevision: 'rev-0' },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, warnings: [], mode: 'normal',
    content: { kind: 'text', text: 'old', newlineMap: { documentVersion: 0, endings: [] } } };
  if (!isOpenDocument(opened)) throw new Error('Invalid fixture');
  const id = registry.openDocument(opened);
  const requests: SaveRequest[] = [];
  const write = vi.fn(async (request: SaveRequest): Promise<ResultEnvelope<SaveAck>> => {
    requests.push(request);
    return transport ? transport(request) : { ok: true, value: { documentVersion: request.documentVersion,
      diskRevision: `rev-${requests.length}` as DiskRevision, sizeBytes: request.text.length, savedAt: '2026-11-03T00:00:00Z' } };
  });
  const destination = vi.fn();
  const saving = new SaveCoordinator(registry, write, undefined, destination, undefined, write);
  const preferences = new SettingsCoordinator();
  let statuses: ReadonlyMap<DocumentId, ExternalStatus> = new Map();
  const listeners = new Set<() => void>();
  const external = { getSnapshot: () => statuses,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  let modal = false;
  const coordinator = new AutoSaveCoordinator(registry, preferences, saving, external, () => modal);
  stops.push(coordinator.start());
  const edit = (text: string, target = id) => {
    const state = registry.getDocument(target)!.state;
    registry.commit(target, [state.update({ changes: { from: 0, to: state.doc.length, insert: text } })]);
  };
  return { registry, id, requests, write, destination, saving, preferences, coordinator, edit,
    modal: (value: boolean) => { modal = value; preferences.setSession('autoSave', true); },
    conflict: () => { statuses = new Map([[id, { kind: 'changed', message: 'External revision changed' }]]); listeners.forEach(listener => listener()); } };
}

it('is off by default, never writes during settings preview, and debounces latest input for exactly 1500ms', async () => {
  const f = setup(); f.edit('first');
  await vi.advanceTimersByTimeAsync(3000); expect(f.write).not.toHaveBeenCalled();
  f.preferences.setPreview('autoSave', true);
  await vi.advanceTimersByTimeAsync(3000); expect(f.write).not.toHaveBeenCalled();
  f.preferences.usePreviewForSession();
  await vi.advanceTimersByTimeAsync(1499); expect(f.write).not.toHaveBeenCalled();
  f.edit('latest');
  await vi.advanceTimersByTimeAsync(1499); expect(f.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.requests).toHaveLength(1); expect(f.requests[0]?.text).toBe('latest');
  expect(f.registry.getDocument(f.id)!.summary.dirty).toBe(false);
});

it('keeps untitled documents on recovery only and suspends named writes while a modal is open', async () => {
  const f = setup(); const untitled = f.registry.createUntitled(); f.edit('draft', untitled);
  f.preferences.setSession('autoSave', true); f.modal(true); f.edit('named');
  await vi.advanceTimersByTimeAsync(3000); expect(f.write).not.toHaveBeenCalled(); expect(f.destination).not.toHaveBeenCalled();
  f.modal(false); await vi.advanceTimersByTimeAsync(1500);
  expect(f.requests).toHaveLength(1); expect(f.requests[0]?.documentId).toBe(f.id);
  expect(f.registry.getDocument(untitled)!.summary.dirty).toBe(true);
});

it('pauses after failure despite new input and resumes only on explicit retry', async () => {
  let calls = 0;
  const f = setup(async request => ++calls === 1
    ? { ok: false, error: { code: 'DISK_FULL', message: 'Controlled disk full', retryable: false } }
    : { ok: true, value: { documentVersion: request.documentVersion, diskRevision: 'rev-1' as DiskRevision, sizeBytes: 8, savedAt: '2026-11-03T00:00:00Z' } });
  f.preferences.setSession('autoSave', true); f.edit('first'); await vi.advanceTimersByTimeAsync(1500);
  expect(f.coordinator.getSnapshot().get(f.id)?.message).toBe('Controlled disk full');
  f.edit('next'); await vi.advanceTimersByTimeAsync(10_000); expect(f.requests).toHaveLength(1);
  f.coordinator.retry(f.id); await vi.advanceTimersByTimeAsync(1500);
  expect(f.requests).toHaveLength(2); expect(f.requests[1]?.text).toBe('next');
  expect(f.coordinator.getSnapshot().size).toBe(0);
});

it('does not write a known conflict or automatically reconcile unknown outcomes', async () => {
  const f = setup(async () => { throw new Error('Lost response'); });
  f.preferences.setSession('autoSave', true); f.edit('first'); await vi.advanceTimersByTimeAsync(1500);
  f.coordinator.retry(f.id); await vi.advanceTimersByTimeAsync(1500); expect(f.requests).toHaveLength(1);
  expect(f.coordinator.getSnapshot().get(f.id)?.message).toContain('手动保存');
  const conflict = setup(); conflict.preferences.setSession('autoSave', true); conflict.edit('local'); conflict.conflict();
  await vi.advanceTimersByTimeAsync(5000); expect(conflict.write).not.toHaveBeenCalled();
  expect(conflict.coordinator.getSnapshot().has(conflict.id)).toBe(true);
});

it('preserves newer input after an old Ack and saves it using the acknowledged revision', async () => {
  let complete: ((result: ResultEnvelope<SaveAck>) => void) | undefined;
  const f = setup(request => request.documentVersion === 1 ? new Promise(resolve => { complete = resolve; })
    : Promise.resolve({ ok: true, value: { documentVersion: request.documentVersion, diskRevision: 'rev-2' as DiskRevision, sizeBytes: 5, savedAt: '2026-11-03T00:00:00Z' } }));
  f.preferences.setSession('autoSave', true); f.edit('first'); await vi.advanceTimersByTimeAsync(1500);
  f.edit('newer'); complete!({ ok: true, value: { documentVersion: 1, diskRevision: 'rev-1' as DiskRevision, sizeBytes: 5, savedAt: '2026-11-03T00:00:00Z' } });
  await vi.advanceTimersByTimeAsync(0); expect(f.registry.getDocument(f.id)!.summary.dirty).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.requests[1]).toMatchObject({ text: 'newer', expectedDiskRevision: 'rev-1' });
  expect(f.registry.getDocument(f.id)!.summary.dirty).toBe(false);
});

it('rechecks opt-in after waiting behind an in-flight manual save', async () => {
  let complete: ((result: ResultEnvelope<SaveAck>) => void) | undefined;
  const f = setup(() => new Promise(resolve => { complete = resolve; }));
  f.preferences.setSession('autoSave', true); f.edit('first'); const manual = f.saving.save(f.id);
  await vi.advanceTimersByTimeAsync(1500); f.edit('newer'); f.preferences.setSession('autoSave', false);
  complete!({ ok: true, value: { documentVersion: 1, diskRevision: 'rev-1' as DiskRevision, sizeBytes: 5, savedAt: '2026-11-03T00:00:00Z' } });
  await manual; await vi.advanceTimersByTimeAsync(5000);
  expect(f.requests).toHaveLength(1); expect(f.registry.getDocument(f.id)!.summary.dirty).toBe(true);
});

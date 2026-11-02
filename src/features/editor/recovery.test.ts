import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentId, ResultEnvelope, SaveAck, WriteRecoverySnapshotRequest, RecoverySnapshotAck } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { RecoveryCoordinator } from './recovery';
import { SaveCoordinator } from './save';

function edit(registry: DocumentRegistry, id: DocumentId, text: string) {
  const document = registry.getDocument(id)!;
  const result = registry.commit(id, [document.state.update({
    changes: { from: document.state.doc.length, insert: text },
  })]);
  expect(result.ok).toBe(true);
}

function acknowledgement(request: WriteRecoverySnapshotRequest): ResultEnvelope<RecoverySnapshotAck> {
  return { ok: true, value: {
    documentId: request.documentId,
    durableVersion: request.documentVersion,
    receiptId: crypto.randomUUID(),
    writtenAt: new Date().toISOString(),
  } };
}

async function settle() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function fixture(transport: (request: WriteRecoverySnapshotRequest) => Promise<ResultEnvelope<RecoverySnapshotAck>>) {
  const registry = new DocumentRegistry();
  const save = new SaveCoordinator(registry, async (): Promise<ResultEnvelope<SaveAck>> => {
    throw new Error('Recovery must not invoke a save');
  });
  const coordinator = new RecoveryCoordinator(registry, save, transport);
  const id = registry.createUntitled();
  const stop = coordinator.start();
  return { registry, coordinator, id, stop };
}

describe('RecoveryCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces dirty input for one second and captures the latest editor state', async () => {
    const requests: WriteRecoverySnapshotRequest[] = [];
    const h = fixture(async request => {
      requests.push(request);
      return acknowledgement(request);
    });
    try {
      edit(h.registry, h.id, 'first');
      await vi.advanceTimersByTimeAsync(900);
      edit(h.registry, h.id, ' second');
      await vi.advanceTimersByTimeAsync(999);
      expect(requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ documentId: h.id, documentVersion: 2, text: 'first second' });
      expect(requests[0]).not.toHaveProperty('baseDiskRevision');
      expect(h.registry.getDocument(h.id)?.summary).toMatchObject({ recoveryProtected: true, recoveryError: null });
    } finally {
      h.stop();
    }
  });

  it('forces a snapshot after five seconds of continuous input', async () => {
    const requests: WriteRecoverySnapshotRequest[] = [];
    const h = fixture(async request => {
      requests.push(request);
      return acknowledgement(request);
    });
    try {
      edit(h.registry, h.id, '1');
      for (let index = 0; index < 5; index++) {
        await vi.advanceTimersByTimeAsync(900);
        edit(h.registry, h.id, String(index + 2));
      }
      await vi.advanceTimersByTimeAsync(499);
      expect(requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ documentVersion: 6, text: '123456' });
    } finally {
      h.stop();
    }
  });

  it('does not mark a stale acknowledgement as protecting newer input', async () => {
    let resolveFirst!: (value: ResultEnvelope<RecoverySnapshotAck>) => void;
    const requests: WriteRecoverySnapshotRequest[] = [];
    const h = fixture(request => {
      requests.push(request);
      return new Promise(resolve => { resolveFirst = resolve; });
    });
    try {
      edit(h.registry, h.id, 'first');
      const first = h.coordinator.flush(h.id);
      await settle();
      expect(requests).toHaveLength(1);
      edit(h.registry, h.id, ' newer');
      resolveFirst(acknowledgement(requests[0]!));
      expect((await first).ok).toBe(true);
      expect(h.registry.getDocument(h.id)?.summary).toMatchObject({
        version: 2, dirty: true, recoveryProtected: false, recoveryError: null,
      });

      const second = h.coordinator.flush(h.id);
      await settle();
      expect(requests).toHaveLength(2);
      resolveFirst(acknowledgement(requests[1]!));
      expect((await second).ok).toBe(true);
      expect(h.registry.getDocument(h.id)?.summary).toMatchObject({
        version: 2, dirty: true, recoveryProtected: true,
      });
    } finally {
      h.stop();
    }
  });

  it('writes a fresh hot-exit snapshot after an in-flight periodic snapshot', async () => {
    const requests: WriteRecoverySnapshotRequest[] = [];
    const resolvers: ((value: ResultEnvelope<RecoverySnapshotAck>) => void)[] = [];
    const h = fixture(request => {
      requests.push(request);
      return new Promise(resolve => { resolvers.push(resolve); });
    });
    try {
      edit(h.registry, h.id, 'draft');
      const periodic = h.coordinator.flush(h.id);
      await settle();
      const hot = h.coordinator.flush(h.id, 'hot-exit');
      await settle();
      expect(requests.map(request => request.reason)).toEqual(['periodic']);
      resolvers[0]!(acknowledgement(requests[0]!));
      await periodic;
      await settle();
      expect(requests.map(request => request.reason)).toEqual(['periodic', 'hot-exit']);
      resolvers[1]!(acknowledgement(requests[1]!));
      expect((await hot).ok).toBe(true);
      expect(h.registry.getDocument(h.id)?.summary).toMatchObject({ recoveryProtected: true });
    } finally {
      h.stop();
    }
  });

  it('shows a failure once and retries only after the document changes', async () => {
    const transport = vi.fn(async (): Promise<ResultEnvelope<RecoverySnapshotAck>> => ({
      ok: false,
      error: { code: 'DISK_FULL', message: 'Controlled recovery storage full', retryable: false },
    }));
    const h = fixture(transport);
    try {
      edit(h.registry, h.id, 'unsaved');
      await h.coordinator.flush(h.id);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(h.registry.getDocument(h.id)?.summary).toMatchObject({
        recoveryProtected: false, recoveryError: 'Controlled recovery storage full',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(transport).toHaveBeenCalledTimes(1);

      edit(h.registry, h.id, ' changed');
      expect(h.registry.getDocument(h.id)?.summary.recoveryError).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      h.stop();
    }
  });

  it('does not restart periodic timers when an in-flight snapshot settles after stop', async () => {
    let resolveSnapshot!: (result: ResultEnvelope<RecoverySnapshotAck>) => void;
    const requests: WriteRecoverySnapshotRequest[] = [];
    const h = fixture(request => {
      requests.push(request);
      return new Promise(resolve => { resolveSnapshot = resolve; });
    });
    edit(h.registry, h.id, 'first');
    const pending = h.coordinator.flush(h.id);
    await settle();
    h.stop();
    edit(h.registry, h.id, ' newer');
    resolveSnapshot(acknowledgement(requests[0]!));
    await pending;
    await vi.advanceTimersByTimeAsync(6000);
    expect(requests).toHaveLength(1);
    expect(h.registry.getDocument(h.id)?.summary.recoveryProtected).toBe(false);
  });
});

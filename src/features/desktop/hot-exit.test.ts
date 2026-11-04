import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import type {
  DiscardRecoveryRequest, DocumentId, LoadedRecoveryEntry, ResultEnvelope,
} from '../../shared/contracts/files';
import { DocumentRegistry } from '../editor/documents';
import type { RecoveryCoordinator } from '../editor/recovery';
import type { SessionCoordinator } from './session';
import { HotExitCoordinator } from './hot-exit';

function recovered(id: DocumentId, version = 2): LoadedRecoveryEntry {
  const text = `draft ${version}`;
  return {
    entry: {
      receiptId: crypto.randomUUID(),
      reason: 'periodic',
      documentId: id,
      bufferVersion: version,
      sourcePath: null,
      sourceRevision: null,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
      newlineMap: { documentVersion: version, endings: [] },
      bodyBytes: new TextEncoder().encode(text).byteLength,
      bodySha256: 'a'.repeat(64),
      createdAt: '2026-11-02T00:00:00.000Z',
    },
    text,
  };
}

function fixture() {
  const registry = new DocumentRegistry();
  const flushRecovery = vi.fn(async (
    id: DocumentId,
    reason: 'periodic' | 'hot-exit',
  ): Promise<ResultEnvelope<{ durableVersion: number } | null>> => {
    void id;
    void reason;
    return { ok: true, value: null };
  });
  const recovery = {
    start: vi.fn(() => () => {}),
    stop: vi.fn(),
    flush: flushRecovery,
  } as unknown as Pick<RecoveryCoordinator, 'start' | 'stop' | 'flush'>;
  const session = {
    start: vi.fn(() => () => {}),
    stop: vi.fn(),
    flush: vi.fn(async () => ({ ok: true as const, value: { saved: true as const, persistedAt: '2026-11-02T00:00:00Z' } })),
    clear: vi.fn(async () => ({ ok: true as const, value: { cleared: true as const } })),
  } as unknown as Pick<SessionCoordinator, 'start' | 'stop' | 'flush' | 'clear'>;
  const discard = vi.fn(async (request: DiscardRecoveryRequest): Promise<ResultEnvelope<{ documentId: DocumentId; throughVersion: number; discarded: true }>> => ({
    ok: true,
    value: { ...request, discarded: true },
  }));
  const destroy = vi.fn(async () => {});
  const removeWindowSession = vi.fn(
    async (): Promise<ResultEnvelope<{ removed: boolean }>> => ({
      ok: true, value: { removed: true },
    }),
  );
  const coordinator = new HotExitCoordinator(
    registry, recovery, session, discard, destroy, removeWindowSession,
  );
  return {
    registry, recovery, flushRecovery, session, discard, destroy,
    removeWindowSession, coordinator,
  };
}

describe('HotExitCoordinator', () => {
  it('freezes input, flushes every dirty document as hot-exit, saves the session and only then closes', async () => {
    const h = fixture();
    const first = crypto.randomUUID() as DocumentId;
    const second = crypto.randomUUID() as DocumentId;
    h.registry.openRecovered(recovered(first));
    h.registry.openRecovered(recovered(second, 3));

    expect((await h.coordinator.prepare()).ok).toBe(true);
    expect(h.flushRecovery.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [first, 'hot-exit'],
      [second, 'hot-exit'],
    ]);
    expect(h.session.flush).toHaveBeenCalledTimes(1);
    expect(h.removeWindowSession).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.registry.getDocument(first)?.state.facet(EditorState.readOnly)).toBe(true);
  });

  it('stays open and frozen when a snapshot fails, then retries without discarding content', async () => {
    const h = fixture();
    const id = crypto.randomUUID() as DocumentId;
    h.registry.openRecovered(recovered(id));
    h.flushRecovery.mockResolvedValueOnce({
      ok: false,
      error: { code: 'DISK_FULL', message: 'controlled recovery full', retryable: false },
    });

    expect((await h.coordinator.prepare()).ok).toBe(false);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      phase: 'failed',
      failedDocumentIds: [id],
    });
    expect(h.registry.getDocument(id)?.summary).toMatchObject({
      dirty: true,
      hotExitFrozen: true,
    });
    expect(h.session.flush).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();

    h.flushRecovery.mockResolvedValueOnce({ ok: true, value: null });
    expect((await h.coordinator.prepare()).ok).toBe(true);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it('writes version tombstones and clears the session before an explicit discard exit', async () => {
    const h = fixture();
    const id = crypto.randomUUID() as DocumentId;
    h.registry.openRecovered(recovered(id, 7));

    expect((await h.coordinator.discardAndExit()).ok).toBe(true);
    expect(h.discard).toHaveBeenCalledWith({ documentId: id, throughVersion: 7 });
    expect(h.session.clear).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.session.flush).not.toHaveBeenCalled();
  });

  it('resumes editing and periodic protection when the user stays after a failure', async () => {
    const h = fixture();
    const id = crypto.randomUUID() as DocumentId;
    h.registry.openRecovered(recovered(id));
    h.flushRecovery.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IPC_UNAVAILABLE', message: 'controlled unavailable', retryable: true },
    });
    await h.coordinator.prepare();
    h.coordinator.resume();
    expect(h.registry.getDocument(id)?.summary.hotExitFrozen).toBe(false);
    expect(h.registry.getDocument(id)?.state.facet(EditorState.readOnly)).toBe(false);
    expect(h.recovery.start).toHaveBeenCalledTimes(1);
    expect(h.session.start).toHaveBeenCalledTimes(1);
    expect(h.coordinator.getSnapshot().phase).toBe('idle');
  });

  it.each(['discard-unknown', 'clear-failed', 'destroy-failed'] as const)(
    'retains content and advances the recovery generation after %s', async failure => {
      const h = fixture();
      const id = crypto.randomUUID() as DocumentId;
      h.registry.openRecovered(recovered(id, 7));
      if (failure === 'discard-unknown') h.discard.mockRejectedValueOnce(new Error('lost reply'));
      if (failure === 'clear-failed') vi.spyOn(h.session, 'clear').mockResolvedValueOnce({
        ok: false, error: { code: 'DISK_FULL', message: 'session clear failed', retryable: false },
      });
      if (failure === 'destroy-failed') h.destroy.mockRejectedValueOnce(new Error('window remains'));
      expect((await h.coordinator.discardAndExit()).ok).toBe(false);
      expect(h.registry.getDocument(id)?.summary).toMatchObject({
        version: 8, dirty: true, recoveryProtected: false, hotExitFrozen: true,
      });
      expect(h.registry.getDocument(id)?.state.facet(EditorState.readOnly)).toBe(true);
      expect(h.registry.getDocument(id)?.state.doc.toString()).toBe('draft 7');
      expect(h.registry.captureRecovery(id)).toMatchObject({ ok: true, value: {
        documentVersion: 8, text: 'draft 7', newlineMap: { documentVersion: 8, endings: [] },
      } });
      h.coordinator.resume();
      expect(h.registry.getDocument(id)?.state.facet(EditorState.readOnly)).toBe(false);
    },
  );

  it('refuses an exit when a nominally successful flush left the dirty version unprotected', async () => {
    const h = fixture();
    const id = h.registry.createUntitled();
    const document = h.registry.getDocument(id)!;
    h.registry.commit(id, [document.state.update({ changes: { from: 0, insert: 'new draft' } })]);
    expect((await h.coordinator.prepare()).ok).toBe(false);
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.session.flush).not.toHaveBeenCalled();
    expect(h.registry.getDocument(id)?.state.doc.toString()).toBe('new draft');
  });

  it('keeps the window open and frozen when current-window session removal is not confirmed', async () => {
    const h = fixture();
    const id = crypto.randomUUID() as DocumentId;
    h.registry.openRecovered(recovered(id));
    h.removeWindowSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IPC_UNAVAILABLE', message: 'session cleanup unavailable', retryable: true },
    });

    expect((await h.coordinator.prepare()).ok).toBe(false);
    expect(h.session.flush).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.registry.getDocument(id)?.summary.hotExitFrozen).toBe(true);
    expect(h.coordinator.getSnapshot().phase).toBe('failed');
  });
});

import { expect, it, vi } from 'vitest';
import type { FileRef, ResultEnvelope } from '../../shared/contracts/files';
import type { InspectedRoot } from '../../bridge/workspace';
import { WorkspaceStore, type WorkspaceRoot } from './store';
import { WorkspaceRoots } from './roots';

it('retains roots after cancelled selection, failed inspection or failed revocation and remaps only successful removal', async () => {
  const root: WorkspaceRoot = { grant: { grantId: 'first', relativePath: '' } as FileRef, displayName: 'first' };
  const store = new WorkspaceStore(async () => ({ ok: true, value: { items: [], nextCursor: null } }));
  store.setRoot(root);
  const remap = vi.fn();
  const failed = { ok: false as const, error: { code: 'CONFLICT' as const, message: 'Controlled failure', retryable: false } };
  let inspection: ResultEnvelope<InspectedRoot> = failed;
  let revocation: ResultEnvelope<{ renamedDocuments: [] }> = failed;
  const releaseRoot = vi.fn(async () => revocation);
  const roots = new WorkspaceRoots(store, remap, { inspectRoot: async () => inspection, releaseRoot },
    async () => ({ ok: true, value: { grant: null, displayName: null } }));
  expect(await roots.chooseRoot()).toEqual({ ok: true, value: null });
  const next = { grant: { grantId: 'second', relativePath: '' } as FileRef, displayName: 'second' };
  expect((await roots.openRoot(next)).ok).toBe(false); expect(releaseRoot).not.toHaveBeenCalled();
  inspection = { ok: true, value: { ref: next.grant, displayName: 'second', displayPath: 'E:/second', canonicalIdentity: 'a'.repeat(64) } };
  expect((await roots.openRoot(next)).ok).toBe(false); expect(store.getSnapshot().roots).toEqual([root]); expect(remap).not.toHaveBeenCalled();
  revocation = { ok: true, value: { renamedDocuments: [] } };
  expect((await roots.openRoot(next)).ok).toBe(true);
  expect(store.getSnapshot().roots[0]?.grant).toEqual(next.grant); expect(remap).toHaveBeenCalledWith([]);
});

import { expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EncodingInspection } from '../../shared/contracts/encoding';
import type { DocumentId, OpenDocument, ResultEnvelope, TextFormat } from '../../shared/contracts/files';
import { DocumentRegistry } from './documents';
import { FormatCoordinator, replacementChanges } from './format-conversion';
import { encodings } from '../../bridge/encoding';
import { SaveCoordinator } from './save';

const targetFormat: TextFormat = { encoding: 'windows-1252', bom: 'none', lineEnding: 'crlf' };
function setup() {
  const registry = new DocumentRegistry(); const id = registry.createUntitled();
  const doc = registry.getDocument(id)!;
  registry.commit(id, [doc.state.update({ changes: { from: 0, insert: 'A😀中\nB' } })]);
  const inspection: EncodingInspection = { encoding: 'windows-1252', documentVersion: 1,
    lossCount: 2, samples: [{ offset: 1, length: 2 }, { offset: 3, length: 1 }], replacementText: 'A??\nB' };
  const transport: typeof encodings = { check: vi.fn(async () => ({ ok: true as const, value: inspection })), reopen: vi.fn() };
  return { registry, id, inspection, transport, coordinator: new FormatCoordinator(registry, transport) };
}

it('requires explicit loss acceptance and converts text plus encoding in one undoable transaction', async () => {
  const { registry, id, coordinator } = setup();
  const planned = await coordinator.plan(id, targetFormat);
  if (!planned.ok) throw new Error('Expected a plan');
  expect(coordinator.apply(planned.value)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('A😀中\nB');
  expect(coordinator.apply(planned.value, true)).toMatchObject({ ok: true, value: { version: 2 } });
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('A??\nB');
  expect(registry.getDocument(id)!.summary.format).toEqual(targetFormat);
  const state = registry.getDocument(id)!.state;
  expect(undo({ state, dispatch: transaction => { registry.commit(id, [transaction]); } })).toBe(true);
  expect(registry.getDocument(id)!.state.doc.toString()).toBe('A😀中\nB');
  expect(registry.getDocument(id)!.summary.format.encoding).toBe('utf-8');
});

it('rejects stale plans and delayed checks without changing the newer buffer', async () => {
  const app = setup();
  const planned = await app.coordinator.plan(app.id, targetFormat);
  if (!planned.ok) throw new Error('Expected a plan');
  let state = app.registry.getDocument(app.id)!.state;
  app.registry.commit(app.id, [state.update({ changes: { from: 0, insert: 'new ' } })]);
  expect(app.coordinator.apply(planned.value, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  let release!: (value: ResultEnvelope<EncodingInspection>) => void;
  vi.mocked(app.transport.check).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const delayed = app.coordinator.plan(app.id, targetFormat);
  state = app.registry.getDocument(app.id)!.state;
  app.registry.commit(app.id, [state.update({ changes: { from: 0, insert: 'later ' } })]);
  release({ ok: true, value: app.inspection });
  expect(await delayed).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(app.registry.getDocument(app.id)!.state.doc.toString()).toBe('later new A😀中\nB');
});

it('rejects forged candidate text and never rewrites newline tokens', () => {
  expect(replacementChanges('a😀\nb', 'a?\nb', 1)).toEqual([{ from: 1, to: 3, insert: '?' }]);
  expect(replacementChanges('a😀\nb', 'x?\nb', 1)).toBeNull();
  expect(replacementChanges('a😀\nb', 'a??b', 2)).toBeNull();
  expect(replacementChanges('a😀\nb', 'a?\nb', 2)).toBeNull();
});

function bound() {
  const registry = new DocumentRegistry();
  const opened: OpenDocument = { documentId: crypto.randomUUID() as DocumentId,
    ref: { grantId: crypto.randomUUID() as OpenDocument['ref']['grantId'], relativePath: '' },
    metadata: { displayPath: 'E:\\fixture\\encoding.txt', sizeBytes: 4, modifiedAt: '2026-11-03T00:00:00Z',
      isReadOnly: false, diskRevision: 'a'.repeat(64) as OpenDocument['metadata']['diskRevision'] },
    format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' }, mode: 'normal', warnings: [],
    content: { kind: 'text', text: 'body', newlineMap: { documentVersion: 0, endings: [] } } };
  const id = registry.openDocument(opened);
  const transport: typeof encodings = { check: vi.fn(), reopen: vi.fn(async (_id, encoding) => ({
    ok: true as const, value: { ...opened, format: { ...opened.format, encoding } },
  })) };
  const recovery = { flush: vi.fn(async () => {
    registry.acknowledgeRecovery(id, registry.getDocument(id)!.summary.version, crypto.randomUUID());
    return { ok: true as const, value: null };
  }) };
  return { registry, id, opened, transport, recovery,
    coordinator: new FormatCoordinator(registry, transport, new SaveCoordinator(registry), recovery) };
}

it('reopens dirty text only after the explicit discard route confirms recovery protection', async () => {
  const app = bound(); const state = app.registry.getDocument(app.id)!.state;
  app.registry.commit(app.id, [state.update({ changes: { from: 0, insert: 'private ' } })]);
  expect(await app.coordinator.reopen(app.id, 1, 'windows-1252', 'clean')).toMatchObject({ ok: false });
  expect(app.transport.reopen).not.toHaveBeenCalled();
  expect(await app.coordinator.reopen(app.id, 1, 'windows-1252', 'discard')).toMatchObject({ ok: true });
  expect(app.recovery.flush).toHaveBeenCalledWith(app.id, 'hot-exit');
  expect(app.recovery.flush.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(app.transport.reopen).mock.invocationCallOrder[0]!);
  expect(app.registry.getDocument(app.id)!.state.doc.toString()).toBe('body');
  expect(app.registry.getDocument(app.id)!.summary).toMatchObject({ dirty: false, version: 2, format: { encoding: 'windows-1252' } });
});

it('retains input that arrives during reopen and restores the prior native interpretation', async () => {
  const app = bound();
  let release!: (value: ResultEnvelope<OpenDocument>) => void;
  vi.mocked(app.transport.reopen).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = app.coordinator.reopen(app.id, 0, 'windows-1252', 'clean');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const state = app.registry.getDocument(app.id)!.state;
  app.registry.commit(app.id, [state.update({ changes: { from: 0, insert: 'later ' } })]);
  release({ ok: true, value: { ...app.opened, format: { ...app.opened.format, encoding: 'windows-1252' } } });
  expect(await pending).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(app.transport.reopen).toHaveBeenLastCalledWith(app.id, 'utf-8', app.opened.metadata.diskRevision);
  expect(app.registry.getDocument(app.id)!.state.doc.toString()).toBe('later body');
  expect(app.registry.getDocument(app.id)!.summary.dirty).toBe(true);
});

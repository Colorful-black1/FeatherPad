import { useRef, useState, useSyncExternalStore } from 'react';
import type { DiskRevision, DocumentId, ResultEnvelope } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';
import type { ExternalChanges } from './external-changes';
import type { SaveCoordinator } from './save';
import { DiskComparison, type DiskComparisonData } from './DiskComparison';

export function ConflictBanner({ id, registry, coordinator, saving }: {
  id: DocumentId; registry: DocumentRegistry; coordinator: ExternalChanges; saving: SaveCoordinator;
}) {
  const statuses = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const documents = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const current = documents.documents.find(document => document.id === id);
  const status = statuses.get(id);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<(DiskComparisonData & { revision: DiskRevision }) | null>(null);
  const origin = useRef<HTMLElement | null>(null);

  function finishDialog() {
    setComparison(null);
    requestAnimationFrame(() => { if (origin.current?.isConnected) origin.current.focus(); else registry.focus(id); });
  }

  async function run(action: () => Promise<ResultEnvelope<unknown>>) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try { const result = await action(); if (!result.ok) setError(result.error.message); return result; }
    finally { submitting.current = false; setBusy(false); }
  }

  async function openComparison() {
    origin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await coordinator.compare(id);
      const document = registry.getDocument(id);
      if (!result.ok) { setError(result.error.message); return; }
      if (!document) return;
      if (result.value.content.kind !== 'text') {
        setError('磁盘文件已进入只读大文件模式，请重新载入后按页查看。'); return;
      }
      setComparison({ version: document.summary.version, memory: document.state.doc.toString(),
        disk: result.value.content.text, revision: result.value.metadata.diskRevision,
        memoryFormat: document.summary.format, diskFormat: result.value.format });
    } finally { submitting.current = false; setBusy(false); }
  }

  function askReload() {
    if (!status?.revision || !current) return;
    origin.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    setError(null);
    setComparison({ version: current.version, memory: '', disk: null, revision: status.revision });
  }

  return <>
    {status && <div className="external-change-banner" role="region" aria-label="外部文件变化" aria-busy={busy}>
      <p aria-live="polite">{status.message}</p>
      <div>
        {status.kind === 'reloaded' ? <button className="plain-button" onClick={() => coordinator.clear(id)}>知道了</button> : <>
          {status.kind === 'changed' && <button className="plain-button" disabled={busy} onClick={() => void openComparison()}>比较磁盘</button>}
          {status.kind === 'changed' && status.revision && <button className="plain-button" disabled={busy} onClick={askReload}>重新载入…</button>}
          {current?.canSaveAs && <button className="plain-button" disabled={busy} onClick={() => void run(async () => {
            const result = await saving.saveAs(id); if (result.ok) coordinator.clear(id); return result;
          })}>另存当前内容…</button>}
          {status.kind === 'changed' && status.revision && current?.canSaveAs && <button className="plain-button" disabled={busy}
            onClick={() => void run(async () => {
              const result = await saving.overwrite(id, status.revision!);
              if (result.ok) coordinator.clear(id); else await coordinator.check(id);
              return result;
            })}>覆盖磁盘…</button>}
          <button className="plain-button" disabled={busy} onClick={() => void run(async () => {
            await coordinator.check(id); return { ok: true, value: null };
          })}>重新核对</button>
        </>}
      </div>
    </div>}
    {error && !comparison && <p className="notice" role="alert">{error}</p>}
    {comparison && <DiskComparison data={comparison} busy={busy} error={error}
      stale={current?.version !== comparison.version || (!!status?.revision && status.revision !== comparison.revision)} onCancel={finishDialog}
      onReload={() => void run(async () => {
        const result = await coordinator.reload(id, comparison.revision, comparison.version);
        if (result.ok) finishDialog(); return result;
      })} />}
  </>;
}

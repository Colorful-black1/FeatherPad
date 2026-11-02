import { files } from '../../bridge/files';
import type { DocumentId, LoadedRecoveryEntry, LoadRecoveryEntryRequest, OpenDocument, RecoveryEntry, RecoveryInventory, ResultEnvelope } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from '../editor/documents';
import type { SaveTransactionCandidate, SessionManifest } from '../../shared/contracts/files';

export interface RecoveryStartupReport {
  restored: DocumentId[];
  corruptEntries: number;
  warnings: string[];
  saveTransactions: SaveTransactionCandidate[];
}

type ListRecovery = () => Promise<ResultEnvelope<RecoveryInventory>>;
type LoadRecovery = (request: LoadRecoveryEntryRequest) => Promise<ResultEnvelope<LoadedRecoveryEntry>>;

function newestFirst(left: RecoveryEntry, right: RecoveryEntry) {
  return right.bufferVersion - left.bufferVersion || right.createdAt.localeCompare(left.createdAt);
}

export class RecoveryStartup {
  constructor(
    private readonly registry: DocumentRegistry,
    private readonly list: ListRecovery = files.listRecoveryEntries,
    private readonly load: LoadRecovery = files.loadRecoveryEntry,
  ) {}

  async restore(
    sources: ReadonlyMap<DocumentId, OpenDocument> = new Map(),
    manifest?: SessionManifest,
  ): Promise<ResultEnvelope<RecoveryStartupReport>> {
    const inventory = await this.list();
    if (!inventory.ok) return inventory;
    const byDocument = new Map<DocumentId, RecoveryEntry[]>();
    const cleanThrough = new Map(manifest?.windows.flatMap(window => window.views
      .filter(view => !view.dirty).map(view => [view.documentId, view.bufferVersion] as const)) ?? []);
    for (const entry of inventory.value.entries) {
      if (sources.has(entry.documentId) && entry.bufferVersion <= (cleanThrough.get(entry.documentId) ?? -1)) continue;
      const entries = byDocument.get(entry.documentId) ?? [];
      entries.push(entry);
      byDocument.set(entry.documentId, entries);
    }
    const restored: LoadedRecoveryEntry[] = [];
    const warnings = [
      ...inventory.value.failures.map(failure => failure.message),
      ...inventory.value.startupWarnings,
    ];
    const staleCutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    const staleDrafts = inventory.value.entries.filter(entry =>
      Date.parse(entry.createdAt) < staleCutoff);
    if (staleDrafts.length > 0) {
      warnings.push(`检测到 ${staleDrafts.length} 个超过30天的恢复副本；仅提示核对清理，未自动删除任何正文。`);
    }
    let corruptEntries = inventory.value.failures.length;
    for (const entries of byDocument.values()) {
      entries.sort(newestFirst);
      for (const entry of entries) {
        const loaded = await this.load({ receiptId: entry.receiptId });
        if (loaded.ok) {
          restored.push(loaded.value);
          break;
        }
        corruptEntries++;
        warnings.push(loaded.error.message);
      }
    }
    restored.sort((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt));
    const ids = restored
      .map(loaded => {
        const source = sources.get(loaded.entry.documentId);
        const diskChanged = source !== undefined
          && loaded.entry.sourceRevision !== null
          && source.metadata.diskRevision !== loaded.entry.sourceRevision;
        if (diskChanged) {
          warnings.push(`“${loaded.entry.sourcePath ?? '恢复文档'}”的磁盘内容已变化；已保留恢复正文并设为只读。`);
        }
        return this.registry.openRecovered(loaded, source, diskChanged);
      });
    return { ok: true, value: { restored: ids, corruptEntries, warnings,
      saveTransactions: inventory.value.saveTransactions } };
  }
}

export const recoveryStartup = new RecoveryStartup(documents);

let startupPromise: ReturnType<RecoveryStartup['restore']> | null = null;

export function restoreRecoveryOnce(
  sources: ReadonlyMap<DocumentId, OpenDocument> = new Map(),
  manifest?: SessionManifest,
) {
  startupPromise ??= recoveryStartup.restore(sources, manifest);
  return startupPromise;
}

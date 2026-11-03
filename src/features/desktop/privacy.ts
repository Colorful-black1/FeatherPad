import type { DocumentId, RecoveryEntry } from '../../shared/contracts/files';

export interface InactiveRecoveryGroup {
  documentId: DocumentId;
  throughVersion: number;
  entries: number;
  bodyBytes: number;
}

export function inactiveRecoveryGroups(
  entries: readonly RecoveryEntry[],
  activeDirtyDocuments: ReadonlySet<DocumentId>,
): InactiveRecoveryGroup[] {
  const groups = new Map<DocumentId, InactiveRecoveryGroup>();
  for (const entry of entries) {
    if (activeDirtyDocuments.has(entry.documentId)) continue;
    const previous = groups.get(entry.documentId);
    groups.set(entry.documentId, {
      documentId: entry.documentId,
      throughVersion: Math.max(previous?.throughVersion ?? 0, entry.bufferVersion),
      entries: (previous?.entries ?? 0) + 1,
      bodyBytes: (previous?.bodyBytes ?? 0) + entry.bodyBytes,
    });
  }
  return [...groups.values()];
}

import type { DirectoryEntry, TransferMode } from '../../shared/contracts/files';

export const workspaceDragType = 'application/x-featherpad-entry';

export interface WorkspaceDragPayload {
  grantId: string;
  relativePath: string;
  revision: string;
}

export function dragPayload(entry: DirectoryEntry): WorkspaceDragPayload {
  return {
    grantId: entry.ref.grantId,
    relativePath: entry.ref.relativePath,
    revision: entry.revision,
  };
}

export function parseDragPayload(text: string): WorkspaceDragPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    if (typeof item.grantId !== 'string' || !item.grantId
      || typeof item.relativePath !== 'string' || !item.relativePath
      || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/i.test(item.revision)) return null;
    return item as unknown as WorkspaceDragPayload;
  } catch {
    return null;
  }
}

export function transferMode(copyRequested: boolean): TransferMode {
  return copyRequested ? 'copy' : 'move';
}

export function transferConfirmation(source: DirectoryEntry, targetName: string, mode: TransferMode) {
  return mode === 'copy'
    ? `将“${source.name}”复制到“${targetName}”？目标已存在时不会覆盖。`
    : `将“${source.name}”移动到“${targetName}”？目标已存在时不会覆盖。`;
}

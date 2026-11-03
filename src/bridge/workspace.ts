import { callCommand, isRecord } from './invoke';
import { isFileRef } from './files';
import type { DocumentId, FileRef, RenamedDocument } from '../shared/contracts/files';

export interface InspectedRoot { ref: FileRef; displayName: string; displayPath: string; canonicalIdentity: string }
export function isInspectedRoot(value: unknown): value is InspectedRoot {
  return isRecord(value) && isFileRef(value.ref) && value.ref.relativePath === ''
    && typeof value.displayName === 'string' && value.displayName.length > 0 && value.displayName.length <= 32767
    && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 32767
    && typeof value.canonicalIdentity === 'string' && /^[0-9a-f]{64}$/.test(value.canonicalIdentity);
}
function isRenamed(value: unknown): value is RenamedDocument {
  return isRecord(value) && typeof value.documentId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.documentId)
    && isFileRef(value.ref) && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 32767;
}
export const workspaceFiles = {
  inspectRoot: (root: FileRef) => callCommand('inspect_workspace_root', { root }, isInspectedRoot),
  releaseRoot: (root: FileRef) => callCommand('release_workspace_root', { root },
    (value): value is { renamedDocuments: RenamedDocument[] } => isRecord(value) && Array.isArray(value.renamedDocuments)
      && value.renamedDocuments.every(isRenamed)
      && new Set(value.renamedDocuments.map(item => item.documentId as DocumentId)).size === value.renamedDocuments.length),
};

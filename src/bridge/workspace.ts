import { callCommand, isRecord } from './invoke';
import { isFileRef } from './files';
import type { DocumentId, FileRef, RenamedDocument } from '../shared/contracts/files';
import {
  isWorkspaceFileDocument,
  type WorkspaceFileConfig,
  type WorkspaceFileDocument,
} from '../features/workspace/workspace-file';

export interface InspectedRoot { ref: FileRef; displayName: string; displayPath: string; canonicalIdentity: string }
export interface WalkWorkspaceRequest {
  requestId: string;
  roots: FileRef[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
  includeHidden: boolean;
  maxFiles?: number;
}
export interface WalkEntry {
  ref: FileRef;
  displayName: string;
  displayPath: string;
  sizeBytes: number;
  isSymlink: boolean;
}
export interface WalkWorkspaceResult {
  requestId: string;
  entries: WalkEntry[];
  skipped: { reason: string; count: number }[];
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}
export interface NativeDropEntry {
  ref: FileRef;
  displayName: string;
  isDirectory: boolean;
}
export function isNativeDropEntries(value: unknown): value is NativeDropEntry[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(item => isRecord(item) && isFileRef(item.ref)
      && typeof item.displayName === 'string' && item.displayName.length > 0
      && item.displayName.length <= 32_767 && typeof item.isDirectory === 'boolean')
    && new Set(value.map(item => (item as NativeDropEntry).ref.grantId)).size === value.length;
}
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
const canonicalUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const safeCount = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;
function isWalkEntry(value: unknown): value is WalkEntry {
  return isRecord(value) && isFileRef(value.ref)
    && typeof value.displayName === 'string' && value.displayName.length > 0 && value.displayName.length <= 32_767
    && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 32_767
    && safeCount(value.sizeBytes) && typeof value.isSymlink === 'boolean';
}
function isWalkResult(value: unknown): value is WalkWorkspaceResult {
  return isRecord(value) && canonicalUuid(value.requestId) && Array.isArray(value.entries)
    && value.entries.length <= 100_000 && value.entries.every(isWalkEntry)
    && Array.isArray(value.skipped) && value.skipped.length <= 64
    && value.skipped.every(item => isRecord(item) && typeof item.reason === 'string'
      && item.reason.length > 0 && item.reason.length <= 128 && safeCount(item.count))
    && typeof value.truncated === 'boolean' && typeof value.cancelled === 'boolean'
    && safeCount(value.elapsedMs);
}
export const workspaceFiles = {
  inspectRoot: (root: FileRef) => callCommand('inspect_workspace_root', { root }, isInspectedRoot),
  releaseRoot: (root: FileRef) => callCommand('release_workspace_root', { root },
    (value): value is { renamedDocuments: RenamedDocument[] } => isRecord(value) && Array.isArray(value.renamedDocuments)
      && value.renamedDocuments.every(isRenamed)
      && new Set(value.renamedDocuments.map(item => item.documentId as DocumentId)).size === value.renamedDocuments.length),
  openFile: () => callCommand('open_workspace_file', {},
    (value): value is WorkspaceFileDocument | null => value === null || isWorkspaceFileDocument(value)),
  saveFile: (document: WorkspaceFileDocument, config: WorkspaceFileConfig) =>
    callCommand('save_workspace_file', { ref: document.ref, expectedRevision: document.revision, config },
      isWorkspaceFileDocument),
  saveFileAs: (config: WorkspaceFileConfig) => callCommand('save_workspace_file_as', { config },
    (value): value is WorkspaceFileDocument | null => value === null || isWorkspaceFileDocument(value)),
  walk: (request: WalkWorkspaceRequest) => callCommand('walk_workspace', { ...request }, isWalkResult),
  cancelWalk: (requestId: string) => callCommand('cancel_workspace_walk', { requestId },
    (value): value is { requestId: string } => isRecord(value) && value.requestId === requestId),
};

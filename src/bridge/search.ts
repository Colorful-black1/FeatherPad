import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { callCommand, isRecord } from './invoke';
import { isFileRef } from './files';
import type { FileRef } from '../shared/contracts/files';

export interface WorkspaceSearchRequest {
  requestId: string;
  roots: FileRef[];
  pattern: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
  includeHidden: boolean;
  maxMatches?: number;
}
export interface SearchMatch {
  line: number;
  column: number;
  start: number;
  end: number;
  snippet: string;
  prefixTruncated: boolean;
  suffixTruncated: boolean;
}
export interface SearchFileResult {
  ref: FileRef;
  displayName: string;
  displayPath: string;
  revision: string;
  encoding: string;
  matches: SearchMatch[];
  truncated: boolean;
}
export interface WorkspaceSearchResult {
  requestId: string;
  files: SearchFileResult[];
  skipped: { reason: string; count: number }[];
  totalMatches: number;
  scannedFiles: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}
export interface WorkspaceSearchProgress {
  requestId: string;
  sequence?: number;
  files?: SearchFileResult[];
  scannedFiles: number;
  matchedFiles: number;
  totalMatches: number;
  elapsedMs: number;
}

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const count = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;
const isMatch = (value: unknown): value is SearchMatch => isRecord(value)
  && count(value.line) && value.line > 0 && count(value.column) && value.column > 0
  && count(value.start) && count(value.end) && value.end >= value.start
  && typeof value.snippet === 'string' && value.snippet.length <= 2_000
  && typeof value.prefixTruncated === 'boolean' && typeof value.suffixTruncated === 'boolean';
const isFileResult = (value: unknown): value is SearchFileResult => isRecord(value)
  && isFileRef(value.ref)
  && typeof value.displayName === 'string' && value.displayName.length > 0 && value.displayName.length <= 32_767
  && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 32_767
  && typeof value.revision === 'string' && /^[0-9a-f]{64}$/.test(value.revision)
  && typeof value.encoding === 'string' && value.encoding.length > 0 && value.encoding.length <= 32
  && Array.isArray(value.matches) && value.matches.length <= 1_000 && value.matches.every(isMatch)
  && typeof value.truncated === 'boolean';
const isSearchResult = (value: unknown): value is WorkspaceSearchResult => isRecord(value)
  && uuid(value.requestId)
  && Array.isArray(value.files) && value.files.length <= 10_000 && value.files.every(isFileResult)
  && Array.isArray(value.skipped) && value.skipped.length <= 64
  && value.skipped.every(item => isRecord(item) && typeof item.reason === 'string'
    && item.reason.length > 0 && item.reason.length <= 128 && count(item.count))
  && count(value.totalMatches) && count(value.scannedFiles)
  && typeof value.truncated === 'boolean' && typeof value.cancelled === 'boolean' && count(value.elapsedMs);

function isProgress(value: unknown): value is WorkspaceSearchProgress {
  return isRecord(value) && uuid(value.requestId)
    && (value.sequence === undefined || (count(value.sequence) && value.sequence > 0))
    && (value.files === undefined || (count(value.sequence) && Array.isArray(value.files)
      && value.files.length <= 25 && value.files.every(isFileResult)))
    && count(value.scannedFiles) && count(value.matchedFiles) && count(value.totalMatches) && count(value.elapsedMs);
}

export const searchBridge = {
  run: (request: WorkspaceSearchRequest) => callCommand('search_workspace', { ...request }, isSearchResult),
  cancel: (requestId: string) => callCommand('cancel_workspace_search', { requestId },
    (value): value is { requestId: string } => isRecord(value) && value.requestId === requestId),
  listenProgress: (listener: (progress: WorkspaceSearchProgress) => void): Promise<UnlistenFn> =>
    listen<unknown>('featherpad:workspace-search-progress', event => {
      if (isProgress(event.payload)) listener(event.payload);
    }),
};

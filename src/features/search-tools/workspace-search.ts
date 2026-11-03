import type {
  SearchFileResult, SearchMatch, WorkspaceSearchProgress, WorkspaceSearchRequest, WorkspaceSearchResult,
} from '../../bridge/search';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import { findMatches, type SearchQuery } from './search-query';

export interface BufferedWorkspaceDocument {
  id: DocumentId;
  ref: FileRef;
  displayName: string;
  displayPath: string;
  text: string;
  version: number;
}
export interface WorkspaceSearchOptions {
  requestId: string;
  roots: FileRef[];
  query: SearchQuery;
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
  includeHidden: boolean;
  maxMatches?: number;
}
export interface SearchFailure {
  code: string;
  message: string;
}
export interface WorkspaceSearchSnapshot {
  phase: 'idle' | 'running' | 'cancelling' | 'complete' | 'failed';
  requestId: string | null;
  options: WorkspaceSearchOptions | null;
  files: readonly SearchFileResult[];
  dirtyFiles: readonly SearchFileResult[];
  progress: WorkspaceSearchProgress | null;
  skipped: readonly { reason: string; count: number }[];
  totalMatches: number;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
  error: SearchFailure | null;
}

type RunSearch = (request: WorkspaceSearchRequest) => Promise<
  | { ok: true; value: WorkspaceSearchResult }
  | { ok: false; error: SearchFailure }
>;
type CancelSearch = (requestId: string) => Promise<
  | { ok: true; value: { requestId: string } }
  | { ok: false; error: SearchFailure }
>;

const initial = (): WorkspaceSearchSnapshot => ({
  phase: 'idle', requestId: null, options: null, files: [], dirtyFiles: [], progress: null,
  skipped: [], totalMatches: 0, truncated: false, cancelled: false, elapsedMs: 0, error: null,
});

function snippetFor(text: string, from: number, to: number): Omit<SearchMatch, 'line' | 'column' | 'start' | 'end'> {
  const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEnd = text.indexOf('\n', to);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const localFrom = from - lineStart;
  const localTo = to - lineStart;
  const chars = [...line];
  const startChars = [...line.slice(0, localFrom)].length;
  const endChars = [...line.slice(0, localTo)].length;
  const context = Math.max(0, Math.floor((2_000 - (endChars - startChars)) / 2));
  const snippetStart = Math.max(0, startChars - context);
  const snippetEnd = Math.min(chars.length, endChars + context);
  return {
    snippet: chars.slice(snippetStart, snippetEnd).join(''),
    prefixTruncated: snippetStart > 0,
    suffixTruncated: snippetEnd < chars.length,
  };
}

function dirtyResult(document: BufferedWorkspaceDocument, options: WorkspaceSearchOptions): SearchFileResult | null {
  const found = findMatches(options.query, document.text);
  if (!found.ok || found.matches.length === 0) return null;
  const matches = found.matches.slice(0, 1_000).map(match => {
    const before = document.text.slice(0, match.from);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    return {
      line,
      column: [...document.text.slice(lineStart, match.from)].length + 1,
      start: match.from,
      end: match.to,
      ...snippetFor(document.text, match.from, match.to),
    };
  });
  return {
    ref: document.ref,
    displayName: document.displayName,
    displayPath: document.displayPath,
    revision: `buffer-${document.version}`,
    encoding: 'buffer',
    matches,
    truncated: found.truncated || found.matches.length > matches.length,
  };
}

function resultKey(ref: FileRef) {
  return `${ref.grantId}\0${ref.relativePath}`;
}

export class WorkspaceSearchStore {
  private readonly listeners = new Set<() => void>();
  private snapshot = initial();
  private generation = 0;

  constructor(private readonly runSearch: RunSearch, private readonly cancelSearch: CancelSearch) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  async start(options: WorkspaceSearchOptions, dirtyDocuments: readonly BufferedWorkspaceDocument[] = []) {
    const generation = ++this.generation;
    const previous = this.snapshot.requestId;
    if (this.snapshot.phase === 'running' || this.snapshot.phase === 'cancelling') {
      if (previous) void this.cancelSearch(previous);
    }
    this.snapshot = {
      ...initial(), phase: 'running', requestId: options.requestId, options,
    };
    this.publish();
    const result = await this.runSearch({
      requestId: options.requestId,
      roots: options.roots,
      pattern: options.query.pattern,
      isRegex: options.query.isRegex,
      isCaseSensitive: options.query.isCaseSensitive,
      isWholeWord: options.query.isWholeWord,
      include: options.include,
      exclude: options.exclude,
      respectGitignore: options.respectGitignore,
      followDirectoryLinks: options.followDirectoryLinks,
      includeHidden: options.includeHidden,
      ...(options.maxMatches === undefined ? {} : { maxMatches: options.maxMatches }),
    });
    if (generation !== this.generation || this.snapshot.requestId !== options.requestId) return;
    if (!result.ok) {
      this.snapshot = { ...this.snapshot, phase: 'failed', error: result.error };
      this.publish();
      return;
    }
    if (result.value.requestId !== options.requestId) {
      this.snapshot = { ...this.snapshot, phase: 'failed',
        error: { code: 'IPC_UNAVAILABLE', message: '搜索回执与请求标识不一致，结果未采用。' } };
      this.publish();
      return;
    }
    const rootIds = new Set(options.roots.map(root => root.grantId));
    const dirty = dirtyDocuments
      .filter(document => rootIds.has(document.ref.grantId))
      .map(document => dirtyResult(document, options))
      .filter((item): item is SearchFileResult => item !== null);
    const dirtyKeys = new Set(dirty.map(item => resultKey(item.ref)));
    const dirtyPaths = new Set(dirty.map(item => item.displayPath.toLocaleLowerCase()));
    const files = result.value.files.filter(item =>
      !dirtyKeys.has(resultKey(item.ref)) && !dirtyPaths.has(item.displayPath.toLocaleLowerCase()));
    const combined = [...files, ...dirty];
    this.snapshot = {
      phase: 'complete', requestId: result.value.requestId, options, files: combined, dirtyFiles: dirty,
      progress: this.snapshot.progress,
      skipped: result.value.skipped,
      totalMatches: combined.reduce((sum, file) => sum + file.matches.length, 0),
      truncated: result.value.truncated || combined.some(file => file.truncated),
      cancelled: result.value.cancelled,
      elapsedMs: result.value.elapsedMs,
      error: null,
    };
    this.publish();
  }

  updateProgress(progress: WorkspaceSearchProgress) {
    if (progress.requestId !== this.snapshot.requestId
      || (this.snapshot.phase !== 'running' && this.snapshot.phase !== 'cancelling')) return;
    this.snapshot = { ...this.snapshot, progress };
    this.publish();
  }

  async cancel() {
    const requestId = this.snapshot.requestId;
    if (!requestId || (this.snapshot.phase !== 'running' && this.snapshot.phase !== 'cancelling')) return false;
    if (this.snapshot.phase !== 'cancelling') {
      this.snapshot = { ...this.snapshot, phase: 'cancelling' };
      this.publish();
    }
    const result = await this.cancelSearch(requestId);
    if (!result.ok && this.snapshot.requestId === requestId) {
      this.snapshot = { ...this.snapshot, phase: 'failed', error: result.error };
      this.publish();
    }
    return result.ok;
  }

  clear() {
    this.generation++;
    const requestId = this.snapshot.requestId;
    if (requestId) void this.cancelSearch(requestId);
    this.snapshot = initial();
    this.publish();
  }

  private publish() {
    this.listeners.forEach(listener => listener());
  }
}

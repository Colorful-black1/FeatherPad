import { workspaceFiles, type WalkEntry } from '../../bridge/workspace';
import type { FileRef } from '../../shared/contracts/files';

const MAX_INDEX_FILES = 20_000;
const MAX_RESULTS = 200;

export interface FileNameMatch {
  entry: WalkEntry;
  score: number;
  positions: readonly number[];
}

export interface WorkspaceFileIndexSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  requestId: string | null;
  signature: string;
  entries: readonly WalkEntry[];
  skipped: readonly { reason: string; count: number }[];
  truncated: boolean;
  error: string | null;
}

const initial = (): WorkspaceFileIndexSnapshot => ({
  phase: 'idle', requestId: null, signature: '', entries: [], skipped: [], truncated: false, error: null,
});

function signatureFor(roots: readonly FileRef[]) {
  return roots.map(root => `${root.grantId}\0${root.relativePath}`).sort().join('\0');
}

/**
 * Walks the selected workspace roots once and keeps the file-name index in
 * memory so typing can filter without re-reading the directory tree.
 */
export class WorkspaceFileIndexStore {
  private readonly listeners = new Set<() => void>();
  private snapshot = initial();
  private generation = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  ensure(roots: readonly FileRef[]) {
    if (roots.length === 0) {
      this.cancel();
      return;
    }
    const signature = signatureFor(roots);
    if (this.snapshot.signature === signature
      && (this.snapshot.phase === 'loading' || this.snapshot.phase === 'ready')) return;
    this.start(roots, signature);
  }

  refresh(roots: readonly FileRef[]) {
    if (roots.length === 0) {
      this.cancel();
      return;
    }
    this.start(roots, signatureFor(roots));
  }

  private start(roots: readonly FileRef[], signature: string) {
    const generation = ++this.generation;
    const previous = this.snapshot.requestId;
    if (previous) void workspaceFiles.cancelWalk(previous);
    const requestId = crypto.randomUUID();
    this.snapshot = { ...initial(), phase: 'loading', requestId, signature };
    this.publish();
    void workspaceFiles.walk({
      requestId,
      roots: [...roots],
      include: [],
      exclude: [],
      respectGitignore: true,
      followDirectoryLinks: false,
      includeHidden: false,
      maxFiles: MAX_INDEX_FILES,
    }).then(result => {
      if (generation !== this.generation) return;
      if (!result.ok) {
        this.snapshot = { ...this.snapshot, phase: 'failed', error: result.error.message };
        this.publish();
        return;
      }
      if (result.value.requestId !== requestId) {
        this.snapshot = { ...this.snapshot, phase: 'failed', error: '文件索引回执与请求不匹配，请重试。' };
        this.publish();
        return;
      }
      this.snapshot = {
        phase: result.value.cancelled ? 'idle' : 'ready',
        requestId,
        signature,
        entries: result.value.entries,
        skipped: result.value.skipped,
        truncated: result.value.truncated,
        error: null,
      };
      this.publish();
    });
  }

  cancel() {
    this.generation++;
    const requestId = this.snapshot.requestId;
    if (requestId) void workspaceFiles.cancelWalk(requestId);
    this.snapshot = initial();
    this.publish();
  }

  private publish() {
    this.listeners.forEach(listener => listener());
  }
}

/** Subsequence matching, case-insensitive, weighted toward prefix/word starts. */
export function fuzzyFileMatches(
  entries: readonly WalkEntry[],
  query: string,
  limit = MAX_RESULTS,
): FileNameMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: FileNameMatch[] = [];
  for (const entry of entries) {
    const name = entry.displayName.toLocaleLowerCase();
    const positions: number[] = [];
    let cursor = 0;
    let last = -2;
    let score = 0;
    let matched = true;
    for (const character of needle) {
      const found = name.indexOf(character, cursor);
      if (found < 0) { matched = false; break; }
      positions.push(found);
      score += 10;
      if (found === last + 1) score += 14;
      else if (last >= 0) score -= Math.min(8, found - last - 1);
      if (found === 0) score += 20;
      if (found === 0 || /[\s._\-/\\]/.test(name[found - 1] ?? '')) score += 8;
      last = found;
      cursor = found + 1;
    }
    if (!matched) continue;
    if (name === needle) score += 120;
    else if (name.startsWith(needle)) score += 50;
    else if (name.includes(needle)) score += 28;
    score -= Math.min(20, Math.floor(name.length / 8));
    matches.push({ entry, score, positions });
  }
  matches.sort((left, right) => right.score - left.score
    || left.entry.displayName.length - right.entry.displayName.length
    || left.entry.displayPath.localeCompare(right.entry.displayPath));
  return matches.slice(0, limit);
}

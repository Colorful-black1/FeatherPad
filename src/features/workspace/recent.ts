import type { FileRef, OpenDocument } from '../../shared/contracts/files';
import type { JsonValue } from '../../shared/contracts/settings';

export const recentHistoryEnabledSetting = 'recentHistoryEnabled' as const;
export const recentHistoryItemsSetting = 'recentHistoryItems' as const;
export const MAX_RECENT_ENTRIES = 50;
const MAX_RECENT_BYTES = 48 * 1024;
const MAX_IDENTITY_LENGTH = 128;
const MAX_RELATIVE_PATH_LENGTH = 32_767;
const MAX_DISPLAY_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 512;

export type RecentKind = 'file' | 'workspace';

export interface RecentEntry {
  readonly id: string;
  readonly kind: RecentKind;
  readonly canonicalIdentity: string;
  readonly ref: FileRef;
  readonly title: string;
  readonly displayPath: string;
  readonly lastOpenedAt: string;
}

export interface RecentCandidate {
  readonly kind: RecentKind;
  readonly canonicalIdentity: string;
  readonly ref: FileRef;
  readonly title: string;
  readonly displayPath: string;
  readonly lastOpenedAt: string;
}

type RecentFileSource = Pick<OpenDocument, 'canonicalIdentity' | 'ref' | 'metadata'>;

interface StoredRecentHistory {
  readonly schemaVersion: 1;
  readonly entries: readonly RecentEntry[];
}

const nonempty = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');

function isFileRef(value: unknown): value is FileRef {
  return !!value && typeof value === 'object'
    && nonempty(Reflect.get(value, 'grantId'), 128)
    && typeof Reflect.get(value, 'relativePath') === 'string'
    && (Reflect.get(value, 'relativePath') as string).length <= MAX_RELATIVE_PATH_LENGTH
    && !(Reflect.get(value, 'relativePath') as string).includes('\0');
}

function entryId(kind: RecentKind, canonicalIdentity: string) {
  return `${kind}:${canonicalIdentity}`;
}

function isTimestamp(value: unknown): value is string {
  return nonempty(value, 64) && Number.isFinite(Date.parse(value));
}

function isRecentEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Reflect.get(value, 'kind');
  const canonicalIdentity = Reflect.get(value, 'canonicalIdentity');
  return (kind === 'file' || kind === 'workspace')
    && nonempty(canonicalIdentity, MAX_IDENTITY_LENGTH)
    && Reflect.get(value, 'id') === entryId(kind, canonicalIdentity)
    && isFileRef(Reflect.get(value, 'ref'))
    && nonempty(Reflect.get(value, 'title'), MAX_TITLE_LENGTH)
    && nonempty(Reflect.get(value, 'displayPath'), MAX_DISPLAY_PATH_LENGTH)
    && isTimestamp(Reflect.get(value, 'lastOpenedAt'));
}

function encodedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function fitBudget(entries: readonly RecentEntry[]): readonly RecentEntry[] {
  const ordered = [...entries]
    .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    .slice(0, MAX_RECENT_ENTRIES);
  while (ordered.length > 0) {
    const document: StoredRecentHistory = { schemaVersion: 1, entries: ordered };
    if (encodedBytes(document) <= MAX_RECENT_BYTES) return ordered;
    ordered.pop();
  }
  return ordered;
}

function fromOpenDocument(document: RecentFileSource, openedAt: string): RecentCandidate {
  const canonicalIdentity = document.canonicalIdentity
    ?? `legacy:${document.ref.grantId}:${document.ref.relativePath}`;
  const displayPath = document.metadata.displayPath.slice(0, MAX_DISPLAY_PATH_LENGTH);
  const title = (displayPath.split(/[\\/]/).pop() || displayPath).slice(0, MAX_TITLE_LENGTH);
  return {
    kind: 'file',
    canonicalIdentity,
    ref: { ...document.ref },
    title,
    displayPath,
    lastOpenedAt: openedAt,
  };
}

export function recentFileCandidate(document: RecentFileSource, openedAt = new Date().toISOString()): RecentCandidate {
  if (!isTimestamp(openedAt)) throw new Error('最近记录时间无效。');
  return fromOpenDocument(document, openedAt);
}

export function recentWorkspaceCandidate(
  grant: FileRef,
  displayName: string,
  openedAt = new Date().toISOString(),
): RecentCandidate {
  if (!isTimestamp(openedAt)) throw new Error('最近记录时间无效。');
  return {
    kind: 'workspace',
    canonicalIdentity: grant.grantId,
    ref: { ...grant, relativePath: '' },
    title: displayName.slice(0, MAX_TITLE_LENGTH),
    displayPath: displayName.slice(0, MAX_DISPLAY_PATH_LENGTH),
    lastOpenedAt: openedAt,
  };
}

export function readRecentHistory(value: JsonValue | undefined): readonly RecentEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.get(value, 'schemaVersion') !== 1) return [];
  const entries: unknown = Reflect.get(value, 'entries');
  if (!Array.isArray(entries) || entries.length > MAX_RECENT_ENTRIES) return [];
  const byId = new Map<string, RecentEntry>();
  for (const candidate of entries) {
    if (!isRecentEntry(candidate)) continue;
    const previous = byId.get(candidate.id);
    if (!previous || Date.parse(candidate.lastOpenedAt) > Date.parse(previous.lastOpenedAt)) {
      byId.set(candidate.id, {
        id: candidate.id,
        kind: candidate.kind,
        canonicalIdentity: candidate.canonicalIdentity,
        ref: { ...candidate.ref },
        title: candidate.title,
        displayPath: candidate.displayPath,
        lastOpenedAt: candidate.lastOpenedAt,
      });
    }
  }
  return fitBudget([...byId.values()]);
}

export function writeRecentHistory(entries: readonly RecentEntry[]): JsonValue {
  const valid = new Map<string, RecentEntry>();
  for (const entry of entries) {
    if (!isRecentEntry(entry)) continue;
    const previous = valid.get(entry.id);
    if (!previous || Date.parse(entry.lastOpenedAt) > Date.parse(previous.lastOpenedAt)) {
      valid.set(entry.id, { ...entry, ref: { ...entry.ref } });
    }
  }
  return { schemaVersion: 1, entries: fitBudget([...valid.values()]).map(entry => ({
    ...entry,
    ref: { ...entry.ref },
  })) };
}

export function addRecentEntry(
  entries: readonly RecentEntry[],
  candidate: RecentCandidate,
): readonly RecentEntry[] {
  const id = entryId(candidate.kind, candidate.canonicalIdentity);
  if (!isRecentEntry({ ...candidate, id })) return entries;
  const next = entries.filter(entry => entry.id !== id);
  const withoutCandidate = writeRecentHistory(next);
  const stored = readRecentHistory(withoutCandidate);
  return readRecentHistory(writeRecentHistory([
    { ...candidate, id, ref: { ...candidate.ref } },
    ...stored,
  ]));
}

export function removeRecentEntry(entries: readonly RecentEntry[], id: string): readonly RecentEntry[] {
  return entries.filter(entry => entry.id !== id);
}

export function clearRecentHistory(): readonly RecentEntry[] {
  return [];
}

export function recentGrantIds(entries: readonly RecentEntry[]): readonly string[] {
  return [...new Set(entries.slice(0, MAX_RECENT_ENTRIES).map(entry => entry.ref.grantId))];
}

import { isFileRef } from '../../bridge/files';
import { isRecord } from '../../bridge/invoke';
import type { JsonValue } from '../../shared/contracts/settings';
import type { RecentCandidate, RecentKind } from './recent';
import type { FileRef } from '../../shared/contracts/files';

export const favoritesSetting = 'workspaceFavorites';
export interface Favorite {
  id: string; kind: RecentKind; canonicalIdentity: string; ref: FileRef; name: string; displayPath: string;
}
export type FavoriteAction = { kind: 'add'; candidate: RecentCandidate } | { kind: 'remove'; id: string }
  | { kind: 'rename'; id: string; name: string } | { kind: 'move'; id: string; delta: -1 | 1 }
  | { kind: 'rebind'; candidate: RecentCandidate; id: string } | { kind: 'clear' };
const string = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !value.includes('\0');
function isFavorite(value: unknown): value is Favorite {
  return isRecord(value) && (value.kind === 'file' || value.kind === 'workspace') && string(value.canonicalIdentity, 128)
    && value.id === `${value.kind}:${value.canonicalIdentity}` && isFileRef(value.ref)
    && string(value.name, 128) && string(value.displayPath, 4096);
}
function invalid(): never { throw new Error('收藏记录损坏或达到100项/32KiB上限，原数据已保留。'); }
export function readFavorites(value: unknown): readonly Favorite[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 100
    || !value.entries.every(isFavorite) || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768) invalid();
  return value.entries.map(entry => ({ ...entry, ref: { ...entry.ref } }));
}
export function mutateFavorites(value: JsonValue | undefined, action: FavoriteAction): JsonValue {
  let entries = [...readFavorites(value)];
  if (action.kind === 'clear') entries = [];
  else if (action.kind === 'add' || action.kind === 'rebind') {
    const candidate = action.candidate;
    const existing = action.kind === 'rebind' ? entries.find(entry => entry.id === action.id)
      : entries.find(entry => entry.kind === candidate.kind && entry.canonicalIdentity === candidate.canonicalIdentity);
    const next: Favorite = { id: `${candidate.kind}:${candidate.canonicalIdentity}`, kind: candidate.kind,
      canonicalIdentity: candidate.canonicalIdentity, ref: { ...candidate.ref }, name: existing?.name ?? candidate.title.slice(0, 128),
      displayPath: candidate.displayPath };
    if (!isFavorite(next)) invalid();
    if (existing) entries = entries.map(entry => entry.id === existing.id ? next : entry).filter((entry, index, all) => all.findIndex(item => item.id === entry.id) === index);
    else entries.push(next);
  } else {
    const index = entries.findIndex(entry => entry.id === action.id);
    if (index >= 0) {
      if (action.kind === 'remove') entries.splice(index, 1);
      if (action.kind === 'rename') {
        const name = action.name.trim(); if (!string(name, 128)) invalid();
        entries[index] = { ...entries[index]!, name };
      }
      if (action.kind === 'move') {
        const target = index + action.delta;
        if (target >= 0 && target < entries.length) [entries[index], entries[target]] = [entries[target]!, entries[index]!];
      }
    }
  }
  const result = { schemaVersion: 1, entries: entries.map(entry => ({ ...entry, ref: { ...entry.ref } })) };
  readFavorites(result);
  return result;
}

export function favoriteGrantIds(value: JsonValue | undefined): string[] {
  try { return [...new Set(readFavorites(value).map(entry => entry.ref.grantId))]; } catch { return []; }
}

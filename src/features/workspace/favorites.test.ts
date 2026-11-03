import { expect, it } from 'vitest';
import type { FileRef } from '../../shared/contracts/files';
import { mutateFavorites, readFavorites } from './favorites';
import { recentWorkspaceCandidate } from './recent';

it('keeps custom names and order independently of history while repairing references', () => {
  const first = recentWorkspaceCandidate({ grantId: 'first', relativePath: '' } as FileRef, 'first');
  const second = recentWorkspaceCandidate({ grantId: 'second', relativePath: '' } as FileRef, 'second');
  let value = mutateFavorites(undefined, { kind: 'add', candidate: first });
  value = mutateFavorites(value, { kind: 'add', candidate: second });
  const id = readFavorites(value)[0]!.id;
  value = mutateFavorites(value, { kind: 'rename', id, name: 'My root' });
  value = mutateFavorites(value, { kind: 'move', id, delta: 1 });
  expect(readFavorites(value).map(entry => entry.name)).toEqual(['second', 'My root']);
  value = mutateFavorites(value, { kind: 'rebind', id, candidate: { ...first, ref: second.ref, displayPath: 'moved' } });
  expect(readFavorites(value)[1]).toMatchObject({ name: 'My root', ref: second.ref, displayPath: 'moved' });
  value = mutateFavorites(value, { kind: 'remove', id });
  expect(readFavorites(value).map(entry => entry.name)).toEqual(['second']);
  value = mutateFavorites(value, { kind: 'clear' });
  expect(readFavorites(value)).toEqual([]);
});

it('rejects damaged, unknown-version and over-budget data without overwriting or truncating it', () => {
  const damaged = { schemaVersion: 7, entries: [] };
  expect(() => mutateFavorites(damaged, { kind: 'remove', id: 'x' })).toThrow(); expect(damaged.schemaVersion).toBe(7);
  let value = mutateFavorites(undefined, { kind: 'add', candidate: recentWorkspaceCandidate({ grantId: 'fixture', relativePath: '' } as FileRef, 'fixture') });
  for (let index = 1; index < 100; index++) value = mutateFavorites(value, { kind: 'add', candidate: recentWorkspaceCandidate({ grantId: `fixture-${index}`, relativePath: '' } as FileRef, 'fixture') });
  expect(readFavorites(value)).toHaveLength(100);
  expect(() => mutateFavorites(value, { kind: 'add', candidate: recentWorkspaceCandidate({ grantId: 'overflow', relativePath: '' } as FileRef, 'fixture') })).toThrow();
  expect(readFavorites(value)).toHaveLength(100);
});

import type { DirectoryEntry, FileRef } from '../../shared/contracts/files';
import type { WorkspaceSnapshot } from './store';

const illegalCharacters = /[<>:"/\\|?*]/;
const reservedNames = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);

export function validateWindowsName(name: string): string | null {
  if (name.length === 0) return '名称不能为空。';
  if (name.length > 255) return '名称不能超过255个字符。';
  if (name.endsWith('.') || name.endsWith(' ')) return '名称不能以点或空格结尾。';
  if (illegalCharacters.test(name) || [...name].some(character => character.charCodeAt(0) < 32)) {
    return '名称不能包含 < > : " / \\ | ? * 或控制字符。';
  }
  const base = name.split('.')[0]?.toUpperCase() ?? '';
  if (reservedNames.has(base)
    || /^(COM|LPT)[1-9¹²³]$/u.test(base)) {
    return `“${base}”是Windows保留设备名。`;
  }
  return null;
}

export function findDirectoryEntry(snapshot: WorkspaceSnapshot, relativePath: string): DirectoryEntry | null {
  for (const record of Object.values(snapshot.records)) {
    const found = record.items.find(entry => entry.ref.relativePath === relativePath);
    if (found) return found;
  }
  return null;
}

export function creationParent(snapshot: WorkspaceSnapshot): FileRef | null {
  const root = snapshot.root;
  if (!root) return null;
  if (!snapshot.selectedPath) return root.grant;
  const selected = findDirectoryEntry(snapshot, snapshot.selectedPath);
  if (selected?.kind === 'directory') return selected.ref;
  const segments = snapshot.selectedPath.split('/').filter(Boolean);
  segments.pop();
  return {
    grantId: root.grant.grantId,
    relativePath: segments.join('/'),
  };
}

export function entryExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : null;
}

export function rebaseRelativePath(path: string, from: string, to: string): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) return null;
  return `${to}${path.slice(from.length)}`;
}

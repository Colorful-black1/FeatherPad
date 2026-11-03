import { isRecord } from '../../bridge/invoke';
import { isFileRef } from '../../bridge/files';
import type { FileRef } from '../../shared/contracts/files';
import type { WorkspaceRoot } from './store';

export const workspaceFileExtension = 'featherpad-workspace';
export const maxWorkspaceFileBytes = 65_536;
export interface WorkspaceFileRoot { name: string; path: string }
export interface WorkspaceFileConfig {
  schemaVersion: 1;
  workspaceId: string;
  roots: WorkspaceFileRoot[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
}
export interface WorkspaceFileDocument {
  ref: FileRef;
  displayName: string;
  displayPath: string;
  revision: string;
  config: WorkspaceFileConfig;
}

const canonicalUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const safeString = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !value.includes('\0');

export function isWorkspaceFileConfig(value: unknown): value is WorkspaceFileConfig {
  return isRecord(value) && value.schemaVersion === 1 && canonicalUuid(value.workspaceId)
    && Array.isArray(value.roots) && value.roots.length > 0 && value.roots.length <= 16
    && value.roots.every(root => isRecord(root) && safeString(root.name, 128) && safeString(root.path, 32_767))
    && Array.isArray(value.exclude) && value.exclude.length <= 256
    && value.exclude.every(item => safeString(item, 1024))
    && typeof value.respectGitignore === 'boolean'
    && typeof value.followDirectoryLinks === 'boolean'
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxWorkspaceFileBytes;
}

export function isWorkspaceFileDocument(value: unknown): value is WorkspaceFileDocument {
  return isRecord(value) && isFileRef(value.ref) && safeString(value.displayName, 32_767)
    && safeString(value.displayPath, 32_767) && revision(value.revision)
    && isWorkspaceFileConfig(value.config);
}

export function workspaceConfigFromRoots(
  roots: readonly WorkspaceRoot[],
  workspaceId: string = crypto.randomUUID(),
  options: Pick<WorkspaceFileConfig, 'exclude' | 'respectGitignore' | 'followDirectoryLinks'> = {
    exclude: [], respectGitignore: true, followDirectoryLinks: false,
  },
): WorkspaceFileConfig {
  if (roots.length === 0 || roots.length > 16) throw new Error('工作区必须有1至16个根。');
  const config: WorkspaceFileConfig = {
    schemaVersion: 1,
    workspaceId,
    roots: roots.map(root => ({
      name: root.displayName.slice(0, 128),
      path: root.displayPath ?? root.displayName,
    })),
    exclude: [...options.exclude],
    respectGitignore: options.respectGitignore,
    followDirectoryLinks: options.followDirectoryLinks,
  };
  if (!isWorkspaceFileConfig(config)) throw new Error('工作区根或排除规则格式无效。');
  return config;
}

export function configuredRootPath(document: WorkspaceFileDocument, root: WorkspaceFileRoot): string {
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(root.path)) return normalizeDisplayPath(root.path);
  const separator = document.displayPath.includes('\\') ? '\\' : '/';
  const base = document.displayPath.replace(/[\\/][^\\/]*$/, '');
  return normalizeDisplayPath(`${base}${separator}${root.path}`);
}

export function normalizeDisplayPath(value: string): string {
  const normalized = value.replaceAll('/', '\\');
  if (normalized.toLocaleLowerCase().startsWith('\\\\?\\unc\\')) {
    return `\\\\${normalized.slice(8)}`.toLocaleLowerCase();
  }
  return (normalized.startsWith('\\\\?\\') ? normalized.slice(4) : normalized).toLocaleLowerCase();
}

export function rootMatchesConfiguredPath(document: WorkspaceFileDocument, index: number,
  displayPath: string): boolean {
  const root = document.config.roots[index];
  return !!root && configuredRootPath(document, root) === normalizeDisplayPath(displayPath);
}

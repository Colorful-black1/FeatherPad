export interface WorkspaceFilters {
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
}

export const defaultWorkspaceFilters: Readonly<WorkspaceFilters> = Object.freeze({
  include: [], exclude: [], respectGitignore: true, followDirectoryLinks: false,
});

export const defaultIgnoredDirectories = ['.git', 'node_modules', 'target', 'dist', 'build'] as const;

export function parsePatternLines(value: string): string[] {
  const patterns = value.split(/\r?\n/).map(pattern => pattern.trim()).filter(Boolean);
  if (patterns.length > 256 || patterns.some(pattern => pattern.length > 1024 || pattern.includes('\0'))) {
    throw new Error('过滤规则最多256行，每行不超过1024字符。');
  }
  return [...new Set(patterns)];
}

export function normalizedFilters(filters: WorkspaceFilters): WorkspaceFilters {
  return {
    include: [...new Set(filters.include.map(item => item.trim()).filter(Boolean))].slice(0, 256),
    exclude: [...new Set(filters.exclude.map(item => item.trim()).filter(Boolean))].slice(0, 256),
    respectGitignore: filters.respectGitignore,
    followDirectoryLinks: filters.followDirectoryLinks,
  };
}

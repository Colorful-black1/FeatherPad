import { describe, expect, it } from 'vitest';
import {
  configuredRootPath,
  isWorkspaceFileConfig,
  normalizeDisplayPath,
  rootMatchesConfiguredPath,
  workspaceConfigFromRoots,
  type WorkspaceFileDocument,
} from './workspace-file';
import type { WorkspaceRoot } from './store';

const grantId = '11111111-1111-4111-8111-111111111111';

describe('portable workspace files', () => {
  it('stores roots relative to the workspace file and resolves them after moving the folder', () => {
    const root = {
      grant: { grantId, relativePath: '' }, displayName: '项目',
      displayPath: 'E:\\projects\\alpha', canonicalIdentity: 'a'.repeat(64),
    } as WorkspaceRoot;
    const config = workspaceConfigFromRoots([root], '22222222-2222-4222-8222-222222222222');
    expect(isWorkspaceFileConfig(config)).toBe(true);
    const document: WorkspaceFileDocument = {
      ref: { grantId: grantId as WorkspaceFileDocument['ref']['grantId'], relativePath: '' },
      displayName: 'alpha.featherpad-workspace',
      displayPath: 'E:\\projects\\alpha.featherpad-workspace',
      revision: 'b'.repeat(64), config: { ...config, roots: [{ name: '项目', path: 'alpha' }] },
    };
    expect(configuredRootPath(document, document.config.roots[0]!)).toBe('e:\\projects\\alpha');
    expect(rootMatchesConfiguredPath(document, 0, 'E:/projects/alpha')).toBe(true);
    expect(normalizeDisplayPath('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');
  });

  it('rejects unknown versions and unsafe embedded NUL', () => {
    expect(isWorkspaceFileConfig({ schemaVersion: 2 })).toBe(false);
    expect(isWorkspaceFileConfig({
      schemaVersion: 1, workspaceId: '22222222-2222-4222-8222-222222222222',
      roots: [{ name: 'x', path: 'bad\0path' }], exclude: [],
      respectGitignore: true, followDirectoryLinks: false,
    })).toBe(false);
  });
});

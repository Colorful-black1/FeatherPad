import { expect, it } from 'vitest';
import { entryExtension, rebaseRelativePath, validateWindowsName } from './file-actions';

it('rejects Windows reserved devices, illegal characters and ambiguous trailing characters', () => {
  for (const name of ['', 'CON', 'nul.txt', 'COM1', 'LPT¹.md', 'bad:name', 'bad/name', 'end.', 'end ', 'x'.repeat(256)]) {
    expect(validateWindowsName(name), name).not.toBeNull();
  }
  for (const name of ['普通 文件.txt', '.hidden', 'CONSOLE.txt', 'COM10.log', 'name.中']) {
    expect(validateWindowsName(name), name).toBeNull();
  }
});

it('preserves rename extensions and remaps only descendant paths', () => {
  expect(entryExtension('archive.tar.gz')).toBe('.gz');
  expect(entryExtension('.gitignore')).toBeNull();
  expect(rebaseRelativePath('folder/child.txt', 'folder', 'renamed')).toBe('renamed/child.txt');
  expect(rebaseRelativePath('folder', 'folder', 'renamed')).toBe('renamed');
  expect(rebaseRelativePath('folderish/file.txt', 'folder', 'renamed')).toBeNull();
});

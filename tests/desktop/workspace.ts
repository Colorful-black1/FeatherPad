import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

type OpenFolder = (target: string) => Promise<void>;

interface FileReference {
  grantId: string;
  relativePath: string;
}

interface DirectoryEntry {
  id: string;
  ref: FileReference;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'junction';
  isHidden: boolean;
  isReadOnly: boolean;
}

interface Result<T> {
  ok: boolean;
  value?: T;
  error?: { code?: string };
}

interface NativeInvoke {
  invoke: (command: string, request: Record<string, unknown>) => Promise<unknown>;
}

export async function verifyNativeWorkspace(
  page: Page,
  dataDir: string,
  openFolder: OpenFolder,
  evidence: string,
) {
  const artifactRoot = path.resolve(process.cwd(), '.artifacts', 'T002');
  assertOwnedChild(artifactRoot, dataDir);
  const root = path.join(dataDir, '工作区 根😀');
  const emptyRoot = path.join(dataDir, '空工作区😀');
  const deniedRoot = path.join(dataDir, '无权限工作区');
  const alpha = path.join(root, 'alpha');
  const denied = path.join(root, 'denied');
  const empty = path.join(root, 'empty');
  const large = path.join(root, 'large');
  const outside = path.join(dataDir, 'workspace outside');
  const junction = path.join(root, '外部链接');
  const nested = path.join(alpha, '打开 中文😀.txt');
  const hidden = path.join(root, '隐藏.txt');
  const readOnly = path.join(root, '只读.txt');
  const account = `${process.env.USERDOMAIN ?? '.'}\\${process.env.USERNAME ?? ''}`;
  let aclChanged: boolean;
  let rootAclChanged = false;

  await mkdir(emptyRoot);
  await mkdir(deniedRoot);
  await writeFile(path.join(deniedRoot, '恢复后根可见.txt'), '可见', 'utf8');
  await mkdir(alpha, { recursive: true });
  await mkdir(denied);
  await mkdir(empty);
  await mkdir(large);
  await mkdir(outside, { recursive: true });
  await Promise.all(Array.from({ length: 205 }, (_, index) =>
    writeFile(path.join(large, `item-${String(index).padStart(3, '0')}.txt`), '分页', 'utf8')));
  await writeFile(nested, '原生目录内容\n第二行', 'utf8');
  await writeFile(path.join(denied, '恢复后可见.txt'), '可见', 'utf8');
  await writeFile(path.join(outside, '越界.txt'), '不得读取', 'utf8');
  await writeFile(hidden, '隐藏文件', 'utf8');
  await writeFile(readOnly, '只读文件', 'utf8');
  await symlink(outside, junction, 'junction');
  await runFile('attrib.exe', ['+H', hidden], { windowsHide: true });
  await runFile('attrib.exe', ['+R', readOnly], { windowsHide: true });
  await runFile('icacls.exe', [denied, '/deny', `${account}:(RD)`], {
    windowsHide: true,
    timeout: 15_000,
  });
  aclChanged = true;

  try {
    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await openFolder(emptyRoot);
    const emptyTree = page.getByRole('tree', { name: `${path.basename(emptyRoot)} 文件树` });
    await expect(emptyTree).toBeVisible();
    await expect(emptyTree.getByText('此文件夹为空', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await openFolder(deniedRoot);
    const deniedTree = page.getByRole('tree', { name: `${path.basename(deniedRoot)} 文件树` });
    await expect(deniedTree.getByRole('treeitem', { name: '恢复后根可见.txt', exact: true })).toBeVisible();
    await runFile('icacls.exe', [deniedRoot, '/deny', `${account}:(RD)`], {
      windowsHide: true,
      timeout: 15_000,
    });
    rootAclChanged = true;
    await page.getByRole('button', { name: '刷新目录树', exact: true }).click();
    await expect(deniedTree.getByRole('alert')).toContainText('没有权限访问所选文件');
    await runFile('icacls.exe', [deniedRoot, '/remove:d', account], { windowsHide: true, timeout: 15_000 });
    await runFile('icacls.exe', [deniedRoot, '/reset'], { windowsHide: true, timeout: 15_000 });
    rootAclChanged = false;
    await deniedTree.getByRole('button', { name: '重试', exact: true }).click();
    await expect(deniedTree.getByRole('treeitem', { name: '恢复后根可见.txt', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await openFolder(root);
    const rootName = path.basename(root);
    const tree = page.getByRole('tree', { name: `${rootName} 文件树` });
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'alpha', exact: true })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: '打开 中文😀.txt', exact: true })).toHaveCount(0);
    await expect(tree.getByRole('treeitem', { name: '隐藏.txt', exact: true })).toHaveCount(0);
    await expect(tree.getByRole('treeitem', { name: /只读\.txt/ })).toContainText('只读');
    await expect(tree.getByRole('treeitem', { name: /外部链接/ })).toContainText('链接');

    await tree.getByRole('treeitem', { name: 'large', exact: true }).click();
    const largeItems = tree.getByRole('treeitem', { name: /^item-\d{3}\.txt$/ });
    await expect(largeItems).toHaveCount(200);
    await tree.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(largeItems).toHaveCount(205);
    await tree.getByRole('treeitem', { name: 'large', exact: true }).click();

    await tree.getByRole('treeitem', { name: 'alpha', exact: true }).click();
    const nestedRow = tree.getByRole('treeitem', { name: '打开 中文😀.txt', exact: true });
    await expect(nestedRow).toBeVisible();
    await nestedRow.click();
    await expect(page.locator('.cm-line')).toHaveText(['原生目录内容', '第二行']);

    await tree.getByRole('treeitem', { name: 'empty', exact: true }).click();
    await expect(tree.getByText('此文件夹为空', { exact: true })).toBeVisible();
    await tree.getByRole('treeitem', { name: 'denied', exact: true }).click();
    await expect(tree.getByRole('alert')).toContainText('没有权限访问所选文件');
    await runFile('icacls.exe', [denied, '/remove:d', account], { windowsHide: true, timeout: 15_000 });
    await runFile('icacls.exe', [denied, '/reset'], { windowsHide: true, timeout: 15_000 });
    aclChanged = false;
    await tree.getByRole('button', { name: '重试', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: '恢复后可见.txt', exact: true })).toBeVisible();

    await page.getByRole('checkbox', { name: '显示隐藏项' }).check();
    await expect(tree.getByRole('treeitem', { name: '隐藏.txt', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '显示隐藏项' }).uncheck();

    const alphaRow = tree.getByRole('treeitem', { name: 'alpha', exact: true });
    await alphaRow.focus();
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: 'denied', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await expect(nestedRow).toBeVisible();
    await nestedRow.click();

    const editor = page.locator('.cm-content');
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' dirty');
    await expect(page.getByRole('tab', { name: /打开 中文😀\.txt 有未保存修改/ })).toBeVisible();
    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await openFolder(root);
    await expect(tree).toBeVisible();
    await expect(editor).toHaveText('原生目录内容第二行 dirty');
    await expect(page.getByRole('tab', { name: /打开 中文😀\.txt 有未保存修改/ })).toBeVisible();

    await page.getByRole('button', { name: '定位当前文件', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: '打开 中文😀.txt', exact: true }))
      .toHaveAttribute('aria-current', 'page');

    await writeFile(path.join(root, '刷新后.txt'), '新文件', 'utf8');
    await page.getByRole('button', { name: '刷新目录树', exact: true }).click();
    await expect(tree.getByRole('treeitem', { name: '刷新后.txt', exact: true })).toBeVisible();
    await expect(nestedRow).toBeVisible();

    await page.evaluate(() => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as NativeInvoke;
      Reflect.set(window, '__workspaceFolderSelection', native.invoke('choose_folder', {}));
    });
    await openFolder(root);
    const directSelection = await page.evaluate(async () => {
      const selected = Reflect.get(window, '__workspaceFolderSelection') as Promise<Result<{
        grant: FileReference;
        displayName: string;
      }>>;
      return selected;
    });
    expect(directSelection.ok).toBe(true);
    const grant = directSelection.value?.grant;
    if (!grant) throw new Error('Native workspace grant missing');
    const boundary = await page.evaluate(async (reference: FileReference) => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as NativeInvoke;
      const rootPage = await native.invoke('list_directory', {
        ref: reference,
        limit: 1000,
      }) as Result<{ items: DirectoryEntry[]; nextCursor: string | null }>;
      const link = rootPage.value?.items.find(entry => entry.name === '外部链接');
      if (!link) throw new Error('Controlled junction entry missing');
      const escaped = await native.invoke('list_directory', { ref: link.ref }) as Result<unknown>;
      const malformed = await native.invoke('list_directory', {
        ref: { ...reference, relativePath: '../workspace outside' },
      }) as Result<unknown>;
      return {
        linkKind: link.kind,
        escapedCode: escaped.error?.code,
        malformedCode: malformed.error?.code,
      };
    }, grant);
    expect(boundary).toEqual({
      linkKind: 'junction',
      escapedCode: 'OUT_OF_SCOPE',
      malformedCode: 'INVALID_INPUT',
    });

    await page.screenshot({ path: path.join(evidence, 'native-workspace-tree.png') });
    return {
      rootName,
      lazyNestedLoadVerified: true,
      paginationVerified: true,
      hiddenFilterVerified: true,
      emptyRootVerified: true,
      permissionDeniedRootAndRetryVerified: true,
      emptyDirectoryVerified: true,
      permissionDeniedAndRetryVerified: true,
      currentFileLocateVerified: true,
      refreshVerified: true,
      keyboardNavigationVerified: true,
      dirtyDocumentPreservedOnRootReplacement: true,
      junctionBoundaryRejected: true,
      scope: 'real Tauri folder dialog, IPC grants, NTFS ACL and junction; 100k direct-child performance measured separately',
    };
  } finally {
    await runFile('attrib.exe', ['-R', readOnly], { windowsHide: true }).catch(() => undefined);
    await runFile('attrib.exe', ['-H', hidden], { windowsHide: true }).catch(() => undefined);
    if (aclChanged) {
      await runFile('icacls.exe', [denied, '/remove:d', account], { windowsHide: true })
        .catch(() => undefined);
      await runFile('icacls.exe', [denied, '/reset'], { windowsHide: true })
        .catch(() => undefined);
    }
    if (rootAclChanged) {
      await runFile('icacls.exe', [deniedRoot, '/remove:d', account], { windowsHide: true })
        .catch(() => undefined);
      await runFile('icacls.exe', [deniedRoot, '/reset'], { windowsHide: true })
        .catch(() => undefined);
    }
    await unlink(junction).catch(() => undefined);
    for (const target of [emptyRoot, deniedRoot, root, outside]) assertOwnedChild(dataDir, target);
    await rm(emptyRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(deniedRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
}

function assertOwnedChild(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing destructive test operation outside owned root: ${child}`);
  }
}

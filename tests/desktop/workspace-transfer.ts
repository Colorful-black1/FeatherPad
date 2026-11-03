import { expect, type Page } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Result<T> { ok: boolean; value?: T; error?: { code?: string; message?: string } }
interface FileReference { grantId: string; relativePath: string }
interface DirectoryEntry {
  id: string;
  ref: FileReference;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'junction';
  revision: string;
}
interface DirectoryPage { items: DirectoryEntry[]; nextCursor: string | null }
interface OpenedDocument { documentId: string }
interface TransferResult {
  entry: DirectoryEntry;
  renamedDocuments: { documentId: string; ref: FileReference }[];
  mode: 'move' | 'copy';
  sourceRemoved: boolean;
}

export async function verifyNativeWorkspaceTransfer(
  page: Page,
  dataDir: string,
  openFolder: (target: string) => Promise<void>,
  evidence: string,
) {
  const owned = path.join(dataDir, 'transfer-owned');
  const relativeOwned = path.relative(dataDir, owned);
  if (!relativeOwned || relativeOwned === '..' || relativeOwned.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeOwned)) {
    throw new Error(`Refusing cleanup outside owned transfer root: ${owned}`);
  }
  const target = path.join(owned, 'target');
  const directory = path.join(owned, 'source-dir');
  await mkdir(target, { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(owned, 'copy.txt'), 'copy payload 中文😀', 'utf8');
  await writeFile(path.join(directory, 'child.txt'), 'move payload', 'utf8');
  try {
    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    await openFolder(owned);
    await expect(page.getByRole('tree', { name: 'transfer-owned 文件树' })).toBeVisible();

    await page.evaluate(() => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      Reflect.set(window, '__transferFolderSelection', native.invoke('choose_folder', {}));
    });
    await openFolder(owned);
    const chosen = await page.evaluate(async () => {
      const selected = Reflect.get(window, '__transferFolderSelection') as Promise<Result<{
        grant: FileReference; displayName: string;
      }>>;
      return selected;
    });
    if (!chosen.ok || !chosen.value) throw new Error('Native root grant missing');

    const observation = await page.evaluate(async ({ directoryName, root }) => {
      const native = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      const page = await native.invoke('list_directory', {
        ref: root, limit: 1000,
      }) as Result<DirectoryPage>;
      if (!page.ok || !page.value) throw new Error('Native root listing failed');
      const copy = page.value.items.find(item => item.name === 'copy.txt');
      const sourceDirectory = page.value.items.find(item => item.name === directoryName);
      const targetEntry = page.value.items.find(item => item.name === 'target');
      if (!copy || !sourceDirectory || !targetEntry) throw new Error('Transfer fixtures missing');
      const targetListing = await native.invoke('list_directory', {
        ref: targetEntry.ref, limit: 1000,
      }) as Result<DirectoryPage>;
      if (!targetListing.ok || !targetListing.value) throw new Error('Target listing failed');

      const copied = await native.invoke('transfer_entry', {
        source: copy.ref,
        targetParent: targetEntry.ref,
        mode: 'copy',
        expectedRevision: copy.revision,
        requestId: crypto.randomUUID(),
      }) as Result<TransferResult>;
      const collision = await native.invoke('transfer_entry', {
        source: copy.ref,
        targetParent: targetEntry.ref,
        mode: 'copy',
        expectedRevision: copy.revision,
        requestId: crypto.randomUUID(),
      }) as Result<TransferResult>;
      const stale = await native.invoke('transfer_entry', {
        source: copy.ref,
        targetParent: targetEntry.ref,
        mode: 'move',
        expectedRevision: '0'.repeat(64),
        requestId: crypto.randomUUID(),
      }) as Result<TransferResult>;

      const childRef = {
        grantId: root.grantId,
        relativePath: `${sourceDirectory.ref.relativePath}/child.txt`,
      };
      const opened = await native.invoke('open_document', { ref: childRef }) as Result<OpenedDocument>;
      if (!opened.ok || !opened.value) throw new Error('Child document did not open');
      const moved = await native.invoke('transfer_entry', {
        source: sourceDirectory.ref,
        targetParent: targetEntry.ref,
        mode: 'move',
        expectedRevision: sourceDirectory.revision,
        requestId: crypto.randomUUID(),
      }) as Result<TransferResult>;
      return {
        root,
        copiedCode: copied.ok ? null : copied.error?.code,
        collisionCode: collision.ok ? null : collision.error?.code,
        staleCode: stale.ok ? null : stale.error?.code,
        moved,
        openedDocumentId: opened.value.documentId,
      };
    }, { directoryName: path.basename(directory), root: chosen.value.grant });

    expect(observation.copiedCode).toBeNull();
    expect(observation.collisionCode).toBe('CONFLICT');
    expect(observation.staleCode).toBe('CONFLICT');
    expect(observation.moved.ok).toBe(true);
    expect(observation.moved.value?.sourceRemoved).toBe(true);
    expect(observation.moved.value?.renamedDocuments[0]?.documentId)
      .toBe(observation.openedDocumentId);
    expect(await readFile(path.join(owned, 'copy.txt'), 'utf8')).toBe('copy payload 中文😀');
    expect(await readFile(path.join(target, 'copy.txt'), 'utf8')).toBe('copy payload 中文😀');
    expect(await readFile(path.join(target, path.basename(directory), 'child.txt'), 'utf8'))
      .toBe('move payload');
    await expect(readFile(path.join(directory, 'child.txt'), 'utf8')).rejects.toThrow();
    await page.screenshot({ path: path.join(evidence, 'native-workspace-transfer.png') });
    return {
      copyVerified: true,
      collisionPreserved: true,
      staleRevisionRejected: true,
      crossParentMoveVerified: true,
      openDocumentRebound: true,
      sourceRemovedAfterVerifiedMove: true,
      scope: 'Real Tauri Release, native choices and filesystem; UI drag pointer synthesis not used',
    };
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}

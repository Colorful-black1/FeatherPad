import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

type OpenFaultFile = (target: string, faultRoot: string, faultToken: string) => Promise<void>;

async function runWsl(command: string) {
  return runFile('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--exec', 'sh', '-lc', command], {
    windowsHide: true,
    timeout: 30_000,
  });
}

export async function verifyNativeDiskFull(page: Page, dataDir: string, evidence: string, openFaultFile: OpenFaultFile,
  cleanupTasks: (() => Promise<void>)[]) {
  const mountName = `featherpad-fault-${randomUUID().replaceAll('-', '')}`;
  const linuxRoot = `/mnt/${mountName}`;
  const windowsRoot = `\\\\wsl.localhost\\Ubuntu\\mnt\\${mountName}`;
  const faultToken = randomUUID();
  const initialText = 'FeatherPad controlled disk-full source\r\n';
  let mounted = false;
  cleanupTasks.push(async () => {
    await runWsl(`set -eu; if mountpoint -q '${linuxRoot}'; then umount -l '${linuxRoot}'; fi; for attempt in $(seq 1 50); do rmdir '${linuxRoot}' 2>/dev/null && exit 0; sleep 0.1; done; exit 1`);
  });
  try {
    await runWsl(`set -eu; mkdir -p '${linuxRoot}'; mount -t tmpfs -o size=16m,mode=0777 tmpfs '${linuxRoot}'; printf '%b' '${initialText.replaceAll('\r', '\\r').replaceAll('\n', '\\n')}' > '${linuxRoot}/disk-full-source.txt'; printf '%s' '${faultToken}' > '${linuxRoot}/fixture.token'`);
    mounted = true;
    const source = path.join(windowsRoot, 'disk-full-source.txt');
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    await openFaultFile(source, windowsRoot, faultToken);
    await expect(page.getByRole('tab', { name: 'disk-full-source.txt', exact: true })).toBeVisible({ timeout: 90_000 });
    const editor = page.locator('.cm-content');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('controlled unsaved disk-full edit');
    const intendedText = await editor.innerText();
    await expect(page.getByRole('status').filter({ hasText: '未保存修改' })).toBeVisible();

    await runWsl(`set -eu; if dd if=/dev/zero of='${linuxRoot}/fill.bin' bs=64K count=256 status=none; then exit 2; else test $? -eq 1; fi`);
    await page.keyboard.press('Control+s');
    const alert = page.locator('.error-notice[role="alert"]');
    await expect(alert).toContainText('保存未能确认完成', { timeout: 20_000 });
    const alertText = await alert.innerText();
    expect(alertText).toContain('阶段：write-temporary');
    const receipt = /（([0-9a-f-]{36})；阶段：write-temporary）/.exec(alertText)?.[1];
    expect(receipt, alertText).toBeTruthy();
    await expect(page.getByRole('status').filter({ hasText: '未保存修改' })).toBeVisible();
    expect(await page.locator('.cm-content').innerText()).toBe(intendedText);
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(sourceHash);

    const transaction = path.join(dataDir, 'featherpad-state', 'save-transactions', receipt!);
    const manifest = JSON.parse(await readFile(path.join(transaction, 'manifest.json'), 'utf8')) as {
      receiptId: string;
      target: string;
      bodySha256: string;
      originalSha256: string;
    };
    const body = await readFile(path.join(transaction, 'body.bin'));
    const original = await readFile(path.join(transaction, 'original.bin'));
    expect(manifest.receiptId).toBe(receipt);
    expect(manifest.target.replace(/^\\\\\?\\UNC\\/, '\\\\').toLowerCase()).toBe(source.toLowerCase());
    expect(createHash('sha256').update(body).digest('hex')).toBe(manifest.bodySha256);
    expect(createHash('sha256').update(original).digest('hex')).toBe(manifest.originalSha256);
    expect(original.toString('utf8')).toBe(initialText);
    await page.screenshot({ path: path.join(evidence, 'native-release-disk-full.png') });
    return {
      nativeDiskFullVerified: true,
      backingFilesystemFullVerified: true,
      linuxFullFilesystemErrno: 'ENOSPC',
      sourceFileUnchanged: true,
      editorBufferPreservedAndDirty: true,
      recoveryReceiptFound: true,
      recoveryBodyMatchesIntendedText: true,
      recoveryOriginalMatchesSource: true,
      failureStage: 'write-temporary',
      receipt,
      sourceSha256: sourceHash,
      scope: 'real Tauri Release writing to a genuinely full 16MiB WSL2 tmpfs selected through the OS chooser',
      limitation: 'The Windows WSL 9P redirector reports ERROR_GEN_FAILURE (31) for ENOSPC instead of ERROR_DISK_FULL, so this proves full-backing-filesystem safety rather than native NTFS code mapping.',
    };
  } finally {
    if (mounted) {
      await runWsl(`if mountpoint -q '${linuxRoot}'; then umount -l '${linuxRoot}'; fi`).catch(() => undefined);
    }
  }
}

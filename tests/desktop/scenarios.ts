import type { Page } from '@playwright/test';
import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyNativeWorkspace } from './workspace';
import { verifyNativeSearch } from './search';
import { verifyNativeDegradedEditing } from './degraded';
import { verifyNativeLargeFiles } from './large-files';
import { verifyNativeDiskFull } from './disk-full';
import { verifyNativeForcedExit } from './forced-exit';
import { verifyNativeTabs } from './tabs';
import { verifyNativeCommands } from './commands';
import { verifyNativeExternal } from './external';
import { verifyNativeMvp } from './mvp';

const runFile = promisify(execFile);
type ChooserAction = 'open' | 'open-folder' | 'open-degraded' | 'open-large-chunk' | 'open-head-preview' | 'open-fault' | 'save' | 'cancel' | 'inspect-external' | 'confirm-external' | 'reject-external';

export interface NativeScenarioContext {
  page: Page;
  child: ChildProcess;
  dataDir: string;
  executable: string;
  executableSha256: string;
  evidence: string;
  cleanupTasks: (() => Promise<void>)[];
}

export class NativeChooser {
  private step = 0;
  constructor(private readonly context: NativeScenarioContext) {}

  async select(action: ChooserAction, target?: string, fault?: { faultRoot: string; faultToken: string }) {
    const { child, dataDir, executable, executableSha256, evidence } = this.context;
    if (!child.pid) throw new Error('Owned native process missing');
    const hash = target && !['open-folder', 'save', 'cancel'].includes(action)
      ? createHash('sha256').update(await readFile(target)).digest('hex') : undefined;
    const manifest = path.join(dataDir, 'focused-chooser.json');
    await writeFile(manifest, JSON.stringify({
      processId: child.pid, workerProcessId: process.pid, executable, executableSha256, action,
      fixtures: target ? [{ path: target, ...(hash ? { sha256: hash } : {}) }] : [], ...fault,
    }));
    const result = await runFile('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/Select-ControlledFixture.ps1'), '-Manifest', manifest],
      { windowsHide: true, timeout: ['open-large-chunk', 'open-head-preview'].includes(action) ? 45_000 : 25_000 });
    await mkdir(path.join(evidence, 'chooser'), { recursive: true });
    await writeFile(path.join(evidence, 'chooser', `${++this.step}-${action}.json`), result.stdout.trim());
  }
}

export async function runFocusedNativeScenario(scenario: string, context: NativeScenarioContext): Promise<unknown> {
  const { page, child, dataDir, evidence, cleanupTasks } = context;
  const chooser = new NativeChooser(context);
  switch (scenario) {
    case 'mvp':
      return verifyNativeMvp(page, dataDir, evidence, (action, target) => chooser.select(action, target));
    case 'external':
      return verifyNativeExternal(page, dataDir, evidence, (action, target) => chooser.select(action, target));
    case 'commands':
      return verifyNativeCommands(page, dataDir, evidence, target => chooser.select('open-folder', target));
    case 'tabs':
      return verifyNativeTabs(page, dataDir, evidence, (action, target) => chooser.select(action, target));
    case 'workspace':
      return verifyNativeWorkspace(page, dataDir, target => chooser.select('open-folder', target), evidence,
        (action, target) => chooser.select(action, target), 'workspace');
    case 'search':
      return verifyNativeSearch(page, dataDir, target => chooser.select('open', target), evidence);
    case 'large-files': {
      await verifyNativeDegradedEditing(page, dataDir, target => chooser.select('open-degraded', target), evidence);
      if (!child.pid) throw new Error('Owned native process missing');
      return verifyNativeLargeFiles(page, dataDir, (target, action) => chooser.select(action, target), evidence, child.pid);
    }
    case 'disk-full':
      return verifyNativeDiskFull(page, dataDir, evidence,
        (target, faultRoot, faultToken) => chooser.select('open-fault', target, { faultRoot, faultToken }), cleanupTasks);
    case 'forced-exit': {
      // The termination verifier needs one named buffer, not the unrelated saving/large-file suites.
      const target = path.join(dataDir, '硬链接 原路径😀.txt');
      await writeFile(target, '强杀专项受控原件😀', 'utf8');
      await page.getByRole('button', { name: '打开文件', exact: true }).click();
      await chooser.select('open', target);
      return verifyNativeForcedExit(page, child, dataDir);
    }
    default:
      throw new Error(`Unsupported focused native scenario: ${scenario}`);
  }
}

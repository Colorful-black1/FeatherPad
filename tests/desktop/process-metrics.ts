import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile = promisify(execFile);

export interface ProcessTreeMetrics {
  sampledAt: string;
  rootProcessId: number;
  processCount: number;
  privateBytes: number;
  workingSetBytes: number;
  processes: {
    processId: number;
    parentProcessId: number;
    name: string;
    privateBytes: number;
    workingSetBytes: number;
  }[];
}

export async function measureProcessTree(root: string, processId: number): Promise<ProcessTreeMetrics> {
  const script = path.join(root, 'scripts', 'Measure-ProcessTree.ps1');
  const { stdout } = await runFile(
    'powershell.exe',
    ['-NoProfile', '-File', script, '-RootProcessId', String(processId)],
    { windowsHide: true, timeout: 15_000 },
  );
  return JSON.parse(stdout) as ProcessTreeMetrics;
}

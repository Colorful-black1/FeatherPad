import { randomUUID } from 'node:crypto';

export const testRunId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
export const nativeScenarios = ['smoke', 'saving', 'tabs', 'workspace', 'editor', 'search', 'large-files', 'disk-full', 'forced-exit', 'regression'] as const;
export type NativeScenario = typeof nativeScenarios[number];

export function isNativeScenario(value: unknown): value is NativeScenario {
  return nativeScenarios.some(scenario => scenario === value);
}

export function evidenceRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error('Invalid test evidence run identifier');
  }
  return value;
}

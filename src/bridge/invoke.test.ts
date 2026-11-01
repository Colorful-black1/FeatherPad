import { describe, expect, it } from 'vitest';
import { callCommand } from './invoke';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

describe('native result boundary', () => {
  it('preserves typed errors and valid success results', async () => {
    expect(await callCommand('example', {}, isCount, async () => ({ ok: true, value: 3 }))).toEqual({ ok: true, value: 3 });
    const error = { code: 'OUT_OF_SCOPE', message: 'Not authorized', retryable: false };
    expect(await callCommand('example', {}, isCount, async () => ({ ok: false, error }))).toEqual({ ok: false, error });
  });
  it('turns malformed payloads and transport rejection into visible IPC failures', async () => {
    for (const value of [null, { ok: true, value: 'wrong' }, { ok: false, error: { code: 'UNKNOWN' } }]) {
      const result = await callCommand('example', {}, isCount, async () => value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('IPC_UNAVAILABLE');
    }
    const result = await callCommand('example', {}, isCount, async () => { throw new Error('sensitive OS path'); });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sensitive OS path');
  });
});

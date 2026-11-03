import { expect, it } from 'vitest';
import { isEncodingInspection } from './encoding';

it('validates bounded loss samples and rejects mismatched empty/replacement replies', () => {
  const clean = { encoding: 'gbk', documentVersion: 1, lossCount: 0, samples: [], replacementText: null };
  const lossy = { ...clean, lossCount: 1, samples: [{ offset: 1, length: 2 }], replacementText: 'a?' };
  expect(isEncodingInspection(clean)).toBe(true);
  expect(isEncodingInspection(lossy)).toBe(true);
  for (const invalid of [
    { ...clean, encoding: 'auto' }, { ...clean, documentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...clean, replacementText: 'altered' }, { ...lossy, replacementText: null },
    { ...lossy, samples: [] }, { ...lossy, samples: [{ offset: -1, length: 2 }] },
    { ...lossy, samples: [{ offset: 0, length: 3 }] },
    { ...lossy, lossCount: 2, samples: [{ offset: 1, length: 2 }, { offset: 2, length: 1 }] },
  ]) expect(isEncodingInspection(invalid)).toBe(false);
});

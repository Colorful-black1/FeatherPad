import { expect, it } from 'vitest';
import { isResourceImage } from './preview';

it('validates preview MIME, base64, byte and decoded pixel budgets at the IPC boundary', () => {
  const image = { mime: 'image/gif', dataBase64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', sizeBytes: 42, width: 1, height: 1 };
  expect(isResourceImage(image)).toBe(true);
  for (const change of [{ mime: 'text/html' }, { dataBase64: '<script>' }, { sizeBytes: 30 * 1024 * 1024 },
    { width: 100_000, height: 100_000 }, { width: null }, { height: 0 }]) expect(isResourceImage({ ...image, ...change })).toBe(false);
  expect(isResourceImage({ ...image, mime: 'image/svg+xml', width: null, height: null })).toBe(true);
});

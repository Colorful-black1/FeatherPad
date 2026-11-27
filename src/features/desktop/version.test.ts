import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

describe('application version', () => {
  it('keeps package, Tauri, Cargo and the rendered app on the same release version', () => {
    const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;
    const tauriVersion = (JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version;
    const cargoVersion = read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1];
    const lockVersion = read('src-tauri/Cargo.lock')
      .match(/name = "featherpad"\r?\nversion = "([^"]+)"/)?.[1];

    expect(new Set([packageVersion, tauriVersion, cargoVersion, lockVersion]))
      .toEqual(new Set(['1.0.0']));
    expect(__APP_VERSION__).toBe('1.0.0');
  });
});

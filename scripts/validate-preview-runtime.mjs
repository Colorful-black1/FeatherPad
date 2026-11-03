import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/features/markdown/preview-runtime.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n').trim();
const hash = `sha256-${createHash('sha256').update(source).digest('base64')}`;
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
for (const key of ['csp', 'devCsp']) {
  if (!config.app.security[key].includes(`'${hash}'`)) throw new Error(`Trusted preview runtime CSP hash mismatch in ${key}: ${hash}`);
}
console.log('Trusted preview runtime CSP hashes match.');

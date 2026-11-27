import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const version = required('version');
const tag = required('tag');
const repo = required('repo');
const assets = path.resolve(root, required('assets'));
const output = path.resolve(root, required('output'));
if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`Invalid --repo: ${repo}`);
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid SemVer version: ${version}`);
}

const candidates = [
  `FeatherPad_${version}_x64-setup.exe`,
  `FeatherPad_${version}_x64-setup.zip`,
];
let asset = '';
let signature = '';
for (const candidate of candidates) {
  try {
    signature = (await readFile(path.join(assets, `${candidate}.sig`), 'utf8')).trim();
    asset = candidate;
    break;
  } catch {
    // Try the next updater bundle shape.
  }
}
if (!asset || !signature) {
  throw new Error(`No signed updater artifact found under ${assets}`);
}

const notes = (await readFile(path.join(root, 'docs/RELEASE-NOTES.md'), 'utf8'))
  .replace(/\0/g, '').trim().slice(0, 20_000);
const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
const platform = { signature, url };
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': platform,
    'windows-x86_64-nsis': platform,
  },
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, version, tag, asset, url }));

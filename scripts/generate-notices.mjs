import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpmScript = process.env.FEATHERPAD_PNPM_SCRIPT ?? process.env.npm_execpath;
if (!pnpmScript) throw new Error('Initialize scripts/Enter-Dev.ps1 before generating notices');
const execute = (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const frontend = JSON.parse(execute(process.execPath, [pnpmScript, 'licenses', 'list', '--prod', '--json']));
const rust = JSON.parse(execute('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline',
  '--filter-platform', 'x86_64-pc-windows-msvc', '--format-version', '1']));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const supplements = JSON.parse(await readFile(path.join(root, 'packaging/licenses/sources.json'), 'utf8'));
for (const entry of supplements) {
  if (sha(await readFile(path.join(root, 'packaging/licenses', entry.file))) !== entry.sha256) {
    throw new Error(`Supplement license checksum changed: ${entry.file}`);
  }
}
// Missing packaged texts were checked against these exact upstream versions.
// New versions must receive a fresh review instead of silently inheriting them.
const fallback = {
  'npm:railroad-diagrams@1.0.0': ['CC0-1.0.txt'],
  'cargo:alloc-stdlib@0.3.0': ['alloc-stdlib-BSD-3-Clause.txt'],
  'cargo:selectors@0.38.0': ['MPL-2.0.txt'],
  'cargo:tauri-plugin@2.7.2': ['tauri-plugin-MIT.txt'],
  'cargo:webview2-com@0.39.1': ['webview2-com-MIT.txt'],
  'cargo:webview2-com-sys@0.39.1': ['webview2-com-MIT.txt'],
  'cargo:webview2-com-macros@0.8.1': ['webview2-com-macros-MIT.txt'],
};
const texts = new Map(), components = [], sourcePackages = [];
async function notice(file, origin) {
  const bytes = await readFile(file), digest = sha(bytes);
  texts.set(digest, bytes.toString('utf8'));
  return { origin, sha256: digest };
}
async function component(ecosystem, name, version, license, directory, repository) {
  const key = `${ecosystem}:${name}@${version}`;
  if (!license || /UNKNOWN|UNLICENSED/i.test(license)) throw new Error(`Missing license declaration: ${key}`);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice|unlicense)([.\-_]|$)/i.test(entry.name))
    .map(entry => entry.name).sort();
  const notices = [];
  for (const file of files) notices.push(await notice(path.join(directory, file), `${key}/${file}`));
  for (const file of fallback[key] ?? []) notices.push(await notice(path.join(root, 'packaging/licenses', file), `supplement:${file}`));
  if (name === 'railroad-diagrams') {
    const source = await readFile(path.join(directory, 'railroad-diagrams.js'), 'utf8');
    const header = source.slice(0, source.indexOf('*/') + 2), digest = sha(header);
    texts.set(digest, header); notices.push({ origin: `${key}/railroad-diagrams.js copyright header`, sha256: digest });
  }
  if (notices.length === 0) throw new Error(`Missing original notice text: ${key}`);
  components.push({ ecosystem, name, version, license, repository, notices });
  if (license === 'MPL-2.0' || name === 'wry') sourcePackages.push({ name, version, directory });
}
for (const item of Object.values(frontend).flat()) {
  if (item.name === 'featherpad') continue;
  const directory = item.paths[0], manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? manifest.homepage ?? null;
  await component('npm', item.name, manifest.version, item.license, directory, repository);
}
for (const item of rust.packages) {
  if (item.name === 'featherpad') continue;
  await component('cargo', item.name, item.version, item.license, path.dirname(item.manifest_path), item.repository);
}
components.sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`, 'en'));
const lockHashes = { pnpm: sha(await readFile(path.join(root, 'pnpm-lock.yaml'))), cargo: sha(await readFile(path.join(root, 'src-tauri/Cargo.lock'))) };
const metadata = { scope: 'npm production graph and Windows Cargo resolved graph (includes build/proc-macro tools); no claim that every listed component is linked',
  lockHashes, componentCount: components.length, licenseTextCount: texts.size, components };
await writeFile(path.join(root, 'packaging/third-party-inventory.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(path.join(root, 'packaging/LICENSE-TEXTS.txt'), [...texts].sort(([a], [b]) => a.localeCompare(b))
  .map(([digest, text]) => `===== SHA256 ${digest} =====\n${text.trimEnd()}\n`).join('\n'));
const lines = ['# Third-party notices', '',
  'Generated from the locked installed dependency graphs by `scripts/generate-notices.mjs`. Original copyright and license texts are preserved in [LICENSE-TEXTS](packaging/LICENSE-TEXTS.txt); look up each SHA256 text ID in the [inventory](packaging/third-party-inventory.json).', '',
  'The inventory includes npm production dependencies and the Windows Cargo graph, including build tools. Inclusion does not imply that all code is linked. WebView2 is supplied by Microsoft separately and is not included in the application archive.', '',
  'The internal candidate distribution includes THIRD-PARTY-SOURCES.zip with the exact unmodified MPL-only crate sources and the modified Wry source, including original per-file notices. Wry patch details are in src-tauri/vendor/wry/PATCH.md. This file does not assign a license to FeatherPad itself.', '',
  `Components: ${components.length}; original text blocks: ${texts.size}.`, '',
  '| Ecosystem | Component | Version | Declared license |', '|---|---|---|---|',
  ...components.map(item => `| ${item.ecosystem} | ${item.name} | ${item.version} | ${item.license} |`), ''];
await writeFile(path.join(root, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'));
// Machine-local source locations are emitted only to stdout for release.ps1,
// never saved in the portable public inventory.
process.stdout.write(JSON.stringify({ ...metadata, components: undefined, sourcePackages }, null, 2) + '\n');

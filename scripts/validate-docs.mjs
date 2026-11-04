import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Documentation/prototype checks only. This does not test the future product.
const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const ignored = new Set(['node_modules', '.git', '.artifacts', '.cache', 'target', 'dist']);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile()) files.push(absolute);
  }
}
await walk(root);
const textFiles = new Map();
for (const file of files) {
  if (/\.(md|html|css|json|ps1|mjs)$/i.test(file)) {
    textFiles.set(file, await readFile(file, 'utf8'));
  }
}
const relative = (file) => path.relative(root, file).replaceAll('\\', '/');
let localLinks = 0;
for (const [file, text] of textFiles) {
  // Build these tokens so the checker does not flag its own source.
  const oldNames = new RegExp(['qi' + 'ye', '\u6816\u9875'].join('|'), 'i');
  if (oldNames.test(text)) failures.push(`${relative(file)}: obsolete project name`);
  if (!file.endsWith('.md')) continue;
  // Ignore fenced code samples; they can contain intentional future paths.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    let destination;
    try { destination = decodeURIComponent(raw.split('#')[0].split('?')[0]); }
    catch { failures.push(`${relative(file)}: malformed link ${raw}`); continue; }
    if (!destination) continue;
    localLinks += 1;
    const resolved = path.resolve(path.dirname(file), destination);
    if (!resolved.startsWith(root)) {
      failures.push(`${relative(file)}: link escapes project: ${raw}`);
      continue;
    }
    try { await stat(resolved); }
    catch { failures.push(`${relative(file)}: missing link ${raw}`); }
  }
}
const matrixText = await readFile(path.join(root, 'docs/FEATURE-MATRIX.md'), 'utf8');
const features = [...matrixText.matchAll(/^\| (F-(?:FILE|WORK|EDIT|MD|SEARCH|DESK)-\d{3}) \|/gm)].map((m) => m[1]);
const featureSet = new Set(features);
if (features.length !== 86 || featureSet.size !== 86) failures.push(`Expected 86 unique features, got ${features.length}/${featureSet.size}`);
function expandFeatures(text) {
  const values = [];
  for (const match of text.matchAll(/F-(FILE|WORK|EDIT|MD|SEARCH|DESK)-(\d{3})(?:\.\.(\d{3}))?/g)) {
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (end < start || end - start > 100) { failures.push(`Invalid feature range ${match[0]}`); continue; }
    for (let i = start; i <= end; i += 1) values.push(`F-${match[1]}-${String(i).padStart(3, '0')}`);
  }
  return values;
}
const taskText = await readFile(path.join(root, 'tasks/todo.md'), 'utf8');
const taskLines = taskText.split('\n').filter((line) => /^\| \[(?: |~|x)\] T\d{3}\b/.test(line));
const tasks = new Map();
const covered = new Set();
for (const line of taskLines) {
  const cells = line.split('|');
  const id = cells[1].match(/T\d{3}/)[0];
  if (tasks.has(id)) failures.push(`Duplicate task ${id}`);
  const dependencies = [];
  for (const match of cells[2].matchAll(/T(\d{3})(?:\.\.(?:T)?(\d{3}))?/g)) {
    for (let n = Number(match[1]); n <= Number(match[2] ?? match[1]); n += 1) {
      dependencies.push(`T${String(n).padStart(3, '0')}`);
    }
  }
  tasks.set(id, dependencies);
  for (const feature of expandFeatures(cells[3])) {
    if (!featureSet.has(feature)) failures.push(`${id}: unknown feature ${feature}`);
    covered.add(feature);
  }
}
if (tasks.size !== 53) failures.push(`Expected 53 tasks, got ${tasks.size}`);
const done = new Set();
const visiting = new Set();
function visit(id) {
  if (!tasks.has(id)) { failures.push(`Missing dependency ${id}`); return; }
  if (visiting.has(id)) { failures.push(`Task dependency cycle at ${id}`); return; }
  if (done.has(id)) return;
  visiting.add(id);
  for (const dependency of tasks.get(id)) visit(dependency);
  visiting.delete(id);
  done.add(id);
}
for (const id of tasks.keys()) visit(id);
for (const feature of features) if (!covered.has(feature)) failures.push(`No implementation task covers ${feature}`);
const modulePrefixes = { 'file-core': 'FILE', workspace: 'WORK', editor: 'EDIT', markdown: 'MD', 'search-tools': 'SEARCH', desktop: 'DESK' };
for (const [moduleName, prefix] of Object.entries(modulePrefixes)) {
  const spec = await readFile(path.join(root, `docs/specs/SPEC-${moduleName}.md`), 'utf8');
  const specFeatures = new Set(expandFeatures(spec));
  for (const feature of features.filter((id) => id.startsWith(`F-${prefix}-`))) {
    if (!specFeatures.has(feature)) failures.push(`${moduleName}: feature not traced ${feature}`);
  }
}
const html = await readFile(path.join(root, 'design/prototype.html'), 'utf8');
let compiledScripts = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=\s*["']https?:/i.test(match[1])) failures.push('Prototype uses remote script');
  if (/type\s*=\s*["']application\/json/i.test(match[1])) continue;
  if (match[2].trim()) {
    try { new vm.Script(match[2], { filename: 'prototype.inline.js' }); compiledScripts += 1; }
    catch (error) { failures.push(`Prototype JS syntax: ${error.message}`); }
  }
}
for (const match of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
  if (/^https?:/i.test(match[1])) failures.push('Prototype uses remote stylesheet');
  else if (!match[1].startsWith('#')) {
    try { await stat(path.resolve(root, 'design', match[1])); }
    catch { failures.push(`Prototype stylesheet missing: ${match[1]}`); }
  }
}
JSON.parse(await readFile(path.join(root, 'docs/environment.snapshot.json'), 'utf8'));
const report = {
  scope: 'documentation and prototype static validation; not product tests',
  checkedAt: new Date().toISOString(),
  files: files.length,
  markdownFiles: [...textFiles.keys()].filter((f) => f.endsWith('.md')).length,
  localLinks,
  featureCount: featureSet.size,
  taskCount: tasks.size,
  taskFeatureCoverage: covered.size,
  specModules: Object.keys(modulePrefixes).length,
  prototypeInlineScriptsCompiled: compiledScripts,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;

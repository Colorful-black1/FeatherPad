export const languageIds = [
  'plaintext', 'markdown', 'json', 'jsonc', 'xml', 'html', 'css',
  'javascript', 'typescript', 'sql', 'yaml', 'java', 'rust', 'python',
  'shell', 'toml', 'ini',
] as const;

export type LanguageId = typeof languageIds[number];

export const languageOptions: readonly { id: LanguageId; label: string }[] = [
  { id: 'plaintext', label: '纯文本' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
  { id: 'jsonc', label: 'JSONC' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML' },
  { id: 'java', label: 'Java' },
  { id: 'rust', label: 'Rust' },
  { id: 'python', label: 'Python' },
  { id: 'shell', label: 'Shell' },
  { id: 'toml', label: 'TOML' },
  { id: 'ini', label: 'INI / Properties' },
];

const byExtension: Readonly<Record<string, LanguageId>> = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  json: 'json', jsonc: 'jsonc',
  xml: 'xml', xsl: 'xml', xslt: 'xml', svg: 'xml',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  java: 'java',
  rs: 'rust',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  log: 'plaintext', txt: 'plaintext', text: 'plaintext',
};

export function detectLanguage(displayPath: string | null): LanguageId {
  if (!displayPath) return 'plaintext';
  const filename = displayPath.split(/[\\/]/).pop() ?? displayPath;
  const dot = filename.lastIndexOf('.');
  if (dot < 1 || dot === filename.length - 1) return 'plaintext';
  return byExtension[filename.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}

export function languageLabel(languageId: LanguageId): string {
  return languageOptions.find(option => option.id === languageId)?.label ?? '纯文本';
}

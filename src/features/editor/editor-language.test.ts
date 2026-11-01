import { describe, expect, it } from 'vitest';
import { ensureSyntaxTree } from '@codemirror/language';
import { detectLanguage, languageIds, languageLabel, type LanguageId } from './editor-language';
import { loadLanguageExtension } from './language-loader';
import { createEditorState } from './editor-state';

describe('language detection and local highlighting modes', () => {
  it('detects every required extension family and falls back to plain text', () => {
    const fixtures: Readonly<Record<string, LanguageId>> = {
      'README.md': 'markdown', 'data.json': 'json', 'settings.jsonc': 'jsonc',
      'feed.xml': 'xml', 'index.html': 'html', 'theme.css': 'css',
      'app.js': 'javascript', 'types.tsx': 'typescript', 'query.sql': 'sql',
      'config.yaml': 'yaml', 'Main.java': 'java', 'main.rs': 'rust',
      'script.py': 'python', 'run.sh': 'shell', 'Cargo.toml': 'toml',
      'settings.ini': 'ini', 'events.log': 'plaintext', 'LICENSE': 'plaintext',
    };
    for (const [path, expected] of Object.entries(fixtures)) expect(detectLanguage(path), path).toBe(expected);
  });

  it.each([
    ['markdown', '# title'],
    ['json', '{"key": true}'],
    ['jsonc', '{// comment\n"key": true}'],
    ['xml', '<root key="value"/>'],
    ['html', '<main>text</main>'],
    ['css', 'body { color: red; }'],
    ['javascript', 'const value = true;'],
    ['typescript', 'interface Value { count: number }'],
    ['sql', 'SELECT * FROM items;'],
    ['yaml', 'key: true'],
    ['java', 'public class Main {}'],
    ['rust', 'fn main() {}'],
    ['python', 'def main():\n    pass'],
    ['shell', 'echo "$HOME"'],
    ['toml', 'key = true'],
    ['ini', '[section]\nkey=value'],
  ] as const)('parses %s without network or language services', async (languageId, source) => {
    const language = await loadLanguageExtension(languageId);
    const state = createEditorState(source, false, { language });
    expect(ensureSyntaxTree(state, source.length, 1_000)?.length).toBeGreaterThan(0);
    expect(languageLabel(languageId)).not.toBe('');
  });

  it('keeps all advertised language identifiers unique and lazy-loads a valid mode for each', async () => {
    expect(new Set(languageIds).size).toBe(languageIds.length);
    for (const languageId of languageIds) {
      await expect(loadLanguageExtension(languageId)).resolves.toBeDefined();
      expect(languageLabel(languageId)).not.toBe('');
    }
  });
});

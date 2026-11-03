import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Language } from '@codemirror/language';
import { escapeHtml } from './parser';

async function codeLanguage(name: string): Promise<Language | null> {
  switch (name.toLowerCase()) {
    case 'js': case 'javascript': case 'jsx': return (await import('@codemirror/lang-javascript')).javascriptLanguage;
    case 'ts': case 'typescript': case 'tsx': return (await import('@codemirror/lang-javascript')).typescriptLanguage;
    case 'json': return (await import('@codemirror/lang-json')).jsonLanguage;
    case 'java': return (await import('@codemirror/lang-java')).javaLanguage;
    case 'html': return (await import('@codemirror/lang-html')).htmlLanguage;
    case 'xml': return (await import('@codemirror/lang-xml')).xmlLanguage;
    case 'css': return (await import('@codemirror/lang-css')).cssLanguage;
    case 'py': case 'python': return (await import('@codemirror/lang-python')).pythonLanguage;
    case 'rs': case 'rust': return (await import('@codemirror/lang-rust')).rustLanguage;
    case 'yaml': case 'yml': return (await import('@codemirror/lang-yaml')).yamlLanguage;
    default: return null;
  }
}

export async function highlightCodeBlock(text: string, language: string): Promise<string> {
  if (text.length > 200_000) return escapeHtml(text);
  const mode = await codeLanguage(language);
  if (!mode) return escapeHtml(text);
  let html = '';
  let position = 0;
  highlightTree(mode.parser.parse(text), classHighlighter, (from, to, classes) => {
    html += escapeHtml(text.slice(position, from));
    html += `<span class="${classes}">${escapeHtml(text.slice(from, to))}</span>`;
    position = to;
  });
  return html + escapeHtml(text.slice(position));
}

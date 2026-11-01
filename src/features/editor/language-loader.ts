import type { Extension } from '@codemirror/state';
import type { LanguageId } from './editor-language';

export async function loadLanguageExtension(languageId: LanguageId): Promise<Extension> {
  switch (languageId) {
    case 'plaintext': return [];
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'jsonc': {
      const [{ StreamLanguage }, { json }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/javascript'),
      ]);
      return StreamLanguage.define(json);
    }
    case 'xml': return (await import('@codemirror/lang-xml')).xml();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'java': return (await import('@codemirror/lang-java')).java();
    case 'rust': return (await import('@codemirror/lang-rust')).rust();
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'shell': {
      const [{ StreamLanguage }, { shell }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/shell'),
      ]);
      return StreamLanguage.define(shell);
    }
    case 'toml': {
      const [{ StreamLanguage }, { toml }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/toml'),
      ]);
      return StreamLanguage.define(toml);
    }
    case 'ini': {
      const [{ StreamLanguage }, { properties }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/properties'),
      ]);
      return StreamLanguage.define(properties);
    }
  }
}

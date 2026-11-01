import type { EditorState, Text, Transaction } from '@codemirror/state';
import type { DocumentId, OpenDocument, ResultEnvelope, TextFormat } from '../../shared/contracts/files';
import { createEditorState } from './editor-state';

export interface DocumentSummary {
  id: DocumentId;
  title: string;
  displayPath: string | null;
  format: TextFormat;
  version: number;
  dirty: boolean;
  readOnlyReason: string | null;
}

interface ManagedDocument {
  summary: DocumentSummary;
  state: EditorState;
  savedText: Text;
  source: Omit<OpenDocument, 'content'> | null;
  originalNewlines: OpenDocument['content']['newlineMap'];
  scroll: { top: number; left: number };
}

interface RegistrySnapshot {
  documents: readonly DocumentSummary[];
  activeId: DocumentId | null;
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY', message: string): ResultEnvelope<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

export class DocumentRegistry {
  private readonly documents = new Map<DocumentId, ManagedDocument>();
  private readonly listeners = new Set<() => void>();
  private snapshot: RegistrySnapshot = { documents: [], activeId: null };
  private untitledCount = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  getDocument(id: DocumentId): Readonly<ManagedDocument> | undefined {
    return this.documents.get(id);
  }

  createUntitled(): DocumentId {
    const id = crypto.randomUUID() as DocumentId;
    const state = createEditorState('', false);
    const summary: DocumentSummary = {
      id, title: `无标题 ${++this.untitledCount}`, displayPath: null,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
      version: 0, dirty: false, readOnlyReason: null,
    };
    this.documents.set(id, {
      summary, state, savedText: state.doc, source: null,
      originalNewlines: { documentVersion: 0, endings: [] }, scroll: { top: 0, left: 0 },
    });
    this.publish(id);
    return id;
  }

  openDocument(document: OpenDocument): DocumentId {
    const id = document.documentId;
    if (!this.documents.has(id)) {
      const readOnlyReason = document.metadata.isReadOnly ? '文件为只读'
        : document.format.lineEnding === 'mixed' ? '混合换行暂以只读方式打开'
          : document.format.encoding !== 'utf-8' ? '此编码暂以只读方式打开' : null;
      const state = createEditorState(document.content.text, readOnlyReason !== null);
      const { content, ...source } = document;
      this.documents.set(id, {
        summary: {
          id, title: document.metadata.displayPath.split(/[\\/]/).pop() || document.metadata.displayPath,
          displayPath: document.metadata.displayPath, format: document.format,
          version: content.newlineMap.documentVersion, dirty: false, readOnlyReason,
        },
        state, savedText: state.doc, source, originalNewlines: content.newlineMap,
        scroll: { top: 0, left: 0 },
      });
    }
    // An alias/reopen only focuses. Incoming disk text never overwrites an existing buffer.
    this.activate(id);
    return id;
  }

  activate(id: DocumentId) {
    if (this.documents.has(id) && this.snapshot.activeId !== id) this.publish(id);
  }

  setScroll(id: DocumentId, top: number, left: number) {
    const document = this.documents.get(id);
    if (document) document.scroll = { top, left };
  }

  commit(id: DocumentId, transactions: readonly Transaction[]): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    let state = document.state;
    let changes = 0;
    // Validate the entire batch before committing any part of it.
    for (const transaction of transactions) {
      if (transaction.startState !== state) return failure('CONFLICT', '文档版本已变化，请重试操作。');
      if (transaction.docChanged && document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
      state = transaction.state;
      if (transaction.docChanged) changes++;
    }
    document.state = state;
    if (changes > 0) {
      document.summary = {
        ...document.summary, version: document.summary.version + changes,
        dirty: !state.doc.eq(document.savedText),
      };
      this.publish(this.snapshot.activeId);
    }
    return { ok: true, value: { version: document.summary.version } };
  }

  private publish(activeId: DocumentId | null) {
    this.snapshot = { documents: [...this.documents.values()].map(document => document.summary), activeId };
    this.listeners.forEach(listener => listener());
  }
}

export const documents = new DocumentRegistry();

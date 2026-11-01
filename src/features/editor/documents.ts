import type { EditorState, Text, Transaction } from '@codemirror/state';
import type { DocumentId, OpenDocument, ResultEnvelope, SaveAck, SaveAsAck, TextFormat } from '../../shared/contracts/files';
import { createEditorState } from './editor-state';
import { captureExisting, captureDestination, acknowledgeExisting, acknowledgeDestination, readOnlyReason,
  type CapturedSave, type CapturedSaveAs } from './document-save-state';
export type { CapturedSave, CapturedSaveAs } from './document-save-state';

export interface DocumentSummary {
  id: DocumentId;
  title: string;
  displayPath: string | null;
  format: TextFormat;
  version: number;
  dirty: boolean;
  readOnlyReason: string | null;
}

export interface ManagedDocument {
  summary: DocumentSummary;
  state: EditorState;
  savedText: Text;
  savedVersion: number;
  source: Omit<OpenDocument, 'content'> | null;
  originalNewlines: OpenDocument['content']['newlineMap'];
  scroll: { top: number; left: number };
}

interface RegistrySnapshot {
  documents: readonly DocumentSummary[];
  activeId: DocumentId | null;
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY' | 'UNSUPPORTED', message: string): ResultEnvelope<never> {
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
      summary, state, savedText: state.doc, savedVersion: 0, source: null,
      originalNewlines: { documentVersion: 0, endings: [] }, scroll: { top: 0, left: 0 },
    });
    this.publish(id);
    return id;
  }

  openDocument(document: OpenDocument): DocumentId {
    const id = document.documentId;
    if (!this.documents.has(id)) {
      const reason = readOnlyReason(document.metadata, document.format);
      const state = createEditorState(document.content.text, reason !== null);
      const { content, ...source } = document;
      this.documents.set(id, {
        summary: {
          id, title: document.metadata.displayPath.split(/[\\/]/).pop() || document.metadata.displayPath,
          displayPath: document.metadata.displayPath, format: document.format,
          version: content.newlineMap.documentVersion, dirty: false, readOnlyReason: reason,
        },
        state, savedText: state.doc, savedVersion: content.newlineMap.documentVersion, source, originalNewlines: content.newlineMap,
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

  captureSave(id: DocumentId): ResultEnvelope<CapturedSave> {
    return captureExisting(this.documents.get(id));
  }

  acknowledgeSave(captured: CapturedSave, ack: SaveAck): ResultEnvelope<{ dirty: boolean }> {
    const result = acknowledgeExisting(this.documents.get(captured.request.documentId), captured, ack);
    if (result.ok) this.publish(this.snapshot.activeId);
    return result;
  }

  captureSaveAs(id: DocumentId, intent: 'save-as' | 'copy' = 'save-as'): ResultEnvelope<CapturedSaveAs> {
    return captureDestination(this.documents.get(id), intent);
  }

  acknowledgeSaveAs(captured: CapturedSaveAs, ack: SaveAsAck): ResultEnvelope<{ dirty: boolean }> {
    const result = acknowledgeDestination(this.documents.get(captured.request.documentId), captured, ack);
    if (result.ok) this.publish(this.snapshot.activeId);
    return result;
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

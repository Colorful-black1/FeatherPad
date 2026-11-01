import type { EditorState, Text, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { DocumentId, OpenDocument, RenamedDocument, ResultEnvelope, SaveAck, SaveAsAck, SaveRequest, TextFormat, TrashEntryResult } from '../../shared/contracts/files';
import { createEditorState, reconfigureBracketMatching, reconfigureCloseBrackets, reconfigureIndentation,
  reconfigureLanguage, setSearchHighlights, type IndentWidth } from './editor-state';
import { countCharacters, editorMetrics, type EditorMetrics } from './editor-metrics';
import { detectLanguage, type LanguageId } from './editor-language';
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
  missing: boolean;
  recoveryProtected: boolean;
  readOnlyReason: string | null;
  canSaveAs: boolean;
  indentWidth: IndentWidth;
  languageId: LanguageId;
  languageSource: 'auto' | 'manual';
  languageRevision: number;
  bracketMatching: boolean;
  closeBrackets: boolean;
}

export interface ManagedDocument {
  summary: DocumentSummary;
  state: EditorState;
  savedText: Text;
  savedVersion: number;
  source: Omit<OpenDocument, 'content'> | null;
  originalNewlines: Extract<OpenDocument['content'], { kind: 'text' }>['newlineMap'];
  fragment: Exclude<OpenDocument['content'], { kind: 'text' }> | null;
  scroll: { top: number; left: number };
  characterCount: number;
}

export interface BufferChange {
  from: number;
  to: number;
  insert: string;
}

interface RegistrySnapshot {
  documents: readonly DocumentSummary[];
  activeId: DocumentId | null;
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY' | 'UNSUPPORTED' | 'INVALID_INPUT', message: string): ResultEnvelope<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

export class DocumentRegistry {
  private readonly documents = new Map<DocumentId, ManagedDocument>();
  private readonly listeners = new Set<() => void>();
  private readonly metrics = new Map<DocumentId, EditorMetrics>();
  private readonly metricsListeners = new Map<DocumentId, Set<() => void>>();
  private readonly languageGenerations = new Map<DocumentId, number>();
  private readonly views = new Map<DocumentId, EditorView>();
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

  getMetrics(id: DocumentId): EditorMetrics | null {
    return this.metrics.get(id) ?? null;
  }

  attachView(id: DocumentId, view: EditorView) {
    this.views.set(id, view);
    return () => {
      if (this.views.get(id) === view) this.views.delete(id);
    };
  }

  readonly subscribeMetrics = (id: DocumentId, listener: () => void) => {
    const listeners = this.metricsListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.metricsListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.metricsListeners.delete(id);
    };
  };

  createUntitled(): DocumentId {
    const id = crypto.randomUUID() as DocumentId;
    const state = createEditorState('', false);
    const summary: DocumentSummary = {
      id, title: `无标题 ${++this.untitledCount}`, displayPath: null,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
      version: 0, dirty: false, missing: false, recoveryProtected: false, readOnlyReason: null,
      canSaveAs: true, indentWidth: 4, languageId: 'plaintext', languageSource: 'auto',
      languageRevision: 0, bracketMatching: true, closeBrackets: true,
    };
    this.documents.set(id, {
      summary, state, savedText: state.doc, savedVersion: 0, source: null,
      originalNewlines: { documentVersion: 0, endings: [] }, fragment: null, scroll: { top: 0, left: 0 },
      characterCount: 0,
    });
    this.publishMetrics(id, state, 0);
    this.publish(id);
    return id;
  }

  openDocument(document: OpenDocument): DocumentId {
    const id = document.documentId;
    if (!this.documents.has(id)) {
      const fragment = document.content.kind === 'text' ? null : document.content;
      const reason = fragment
        ? document.content.kind === 'chunked'
          ? '大文件以只读分块方式打开，无法保存完整文件'
          : '内容为前1MiB截断预览，无法保存'
        : readOnlyReason(document.metadata, document.format);
      const initialText = document.content.kind === 'text'
        ? document.content.text
        : document.content.kind === 'chunked'
          ? document.content.initialChunk.text
          : document.content.text;
      const languageId = document.mode === 'degraded' ? 'plaintext' : detectLanguage(document.metadata.displayPath);
      const state = createEditorState(initialText, reason !== null);
      const newlineMap = document.content.kind === 'text'
        ? document.content.newlineMap
        : { documentVersion: 0 as const, endings: [] as ('lf' | 'crlf' | 'cr')[] };
      const source = {
        documentId: document.documentId,
        ref: document.ref,
        metadata: document.metadata,
        format: document.format,
        warnings: document.warnings,
        mode: document.mode,
      };
      this.documents.set(id, {
        summary: {
          id, title: document.metadata.displayPath.split(/[\\/]/).pop() || document.metadata.displayPath,
          displayPath: document.metadata.displayPath, format: document.format,
          version: newlineMap.documentVersion, dirty: false, missing: false, recoveryProtected: false, readOnlyReason: reason,
          canSaveAs: fragment === null, indentWidth: 4, languageId, languageSource: 'auto',
          languageRevision: 0, bracketMatching: true, closeBrackets: true,
        },
        state, savedText: state.doc, savedVersion: newlineMap.documentVersion, source,
        originalNewlines: newlineMap, fragment, scroll: { top: 0, left: 0 },
        characterCount: countCharacters(initialText),
      });
      this.scheduleLanguage(id);
      this.publishMetrics(id, state, this.documents.get(id)!.characterCount);
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

  selectRange(id: DocumentId, from: number, to: number, focus = true): boolean {
    const view = this.views.get(id);
    if (!view) return false;
    const anchor = Math.max(0, Math.min(view.state.doc.length, from));
    const head = Math.max(0, Math.min(view.state.doc.length, to));
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    if (focus) view.focus();
    return true;
  }

  focus(id: DocumentId): boolean {
    const view = this.views.get(id);
    if (!view) return false;
    view.focus();
    return true;
  }

  highlightSearch(id: DocumentId, ranges: readonly { from: number; to: number; current: boolean }[]) {
    const view = this.views.get(id);
    if (view) view.dispatch({ effects: setSearchHighlights.of(ranges) });
  }

  replaceRanges(id: DocumentId, expectedVersion: number, changes: readonly BufferChange[]): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    const view = this.views.get(id);
    if (!document || !view) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
    if (document.summary.version !== expectedVersion) return failure('CONFLICT', '文档已变化，请重新查找后再替换。');
    let previousTo = -1;
    for (const change of changes) {
      if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
        || change.from < previousTo || change.to < change.from || change.to > view.state.doc.length) {
        return failure('INVALID_INPUT', '替换范围无效，请重新查找。');
      }
      previousTo = change.to;
    }
    view.dispatch({ changes: changes.map(change => ({ ...change })) });
    const latest = this.documents.get(id);
    return latest ? { ok: true, value: { version: latest.summary.version } } : failure('NOT_FOUND', '文档已关闭。');
  }

  setIndentWidth(id: DocumentId, indentWidth: IndentWidth) {
    const document = this.documents.get(id);
    if (!document || document.summary.indentWidth === indentWidth) return;
    document.state = reconfigureIndentation(document.state, indentWidth);
    document.summary = { ...document.summary, indentWidth };
    this.publish(this.snapshot.activeId);
  }

  setLanguage(id: DocumentId, selection: 'auto' | LanguageId) {
    const document = this.documents.get(id);
    if (!document) return;
    const languageId = selection === 'auto'
      ? document.source?.mode === 'degraded' ? 'plaintext' : detectLanguage(document.summary.displayPath)
      : selection;
    const languageSource = selection === 'auto' ? 'auto' : 'manual';
    if (document.summary.languageId === languageId && document.summary.languageSource === languageSource) return;
    document.state = reconfigureLanguage(document.state, []);
    document.summary = {
      ...document.summary, languageId, languageSource, languageRevision: document.summary.languageRevision + 1,
    };
    this.scheduleLanguage(id);
    this.publish(this.snapshot.activeId);
  }

  setBracketMatching(id: DocumentId, enabled: boolean) {
    const document = this.documents.get(id);
    if (!document || document.summary.bracketMatching === enabled) return;
    document.state = reconfigureBracketMatching(document.state, enabled);
    document.summary = { ...document.summary, bracketMatching: enabled };
    this.publish(this.snapshot.activeId);
  }

  setCloseBrackets(id: DocumentId, enabled: boolean) {
    const document = this.documents.get(id);
    if (!document || document.summary.closeBrackets === enabled) return;
    document.state = reconfigureCloseBrackets(document.state, enabled);
    document.summary = { ...document.summary, closeBrackets: enabled };
    this.publish(this.snapshot.activeId);
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
    if (result.ok) {
      const document = this.documents.get(captured.request.documentId);
      if (document?.summary.languageSource === 'auto') {
        const languageId = document.source?.mode === 'degraded' ? 'plaintext' : detectLanguage(document.summary.displayPath);
        if (languageId !== document.summary.languageId) {
          document.state = reconfigureLanguage(document.state, []);
          document.summary = {
            ...document.summary, languageId, languageRevision: document.summary.languageRevision + 1,
          };
          this.scheduleLanguage(captured.request.documentId);
        }
      }
      this.publish(this.snapshot.activeId);
    }
    return result;
  }

  applyRenamedPaths(renamed: readonly RenamedDocument[]) {
    let changed = false;
    for (const mapping of renamed) {
      const document = this.documents.get(mapping.documentId);
      if (!document?.source) continue;
      const title = mapping.displayPath.split(/[\\/]/).pop() || mapping.displayPath;
      document.source = {
        ...document.source,
        ref: mapping.ref,
        metadata: { ...document.source.metadata, displayPath: mapping.displayPath },
      };
      document.summary = {
        ...document.summary,
        title,
        displayPath: mapping.displayPath,
      };
      if (document.summary.languageSource === 'auto') {
        const languageId = document.source.mode === 'degraded' ? 'plaintext' : detectLanguage(mapping.displayPath);
        if (languageId !== document.summary.languageId) {
          document.state = reconfigureLanguage(document.state, []);
          document.summary = {
            ...document.summary,
            languageId,
            languageRevision: document.summary.languageRevision + 1,
          };
          this.scheduleLanguage(mapping.documentId);
        }
      }
      changed = true;
    }
    if (changed) this.publish(this.snapshot.activeId);
  }

  captureTrashSnapshots(ids: readonly DocumentId[]): ResultEnvelope<SaveRequest[]> {
    const snapshots: SaveRequest[] = [];
    for (const id of ids) {
      const document = this.documents.get(id);
      if (!document?.source) return failure('NOT_FOUND', '受影响文档尚未载入，请重新打开后确认。');
      const captured = captureDestination(document, 'copy');
      if (!captured.ok) return captured;
      const { request } = captured.value;
      snapshots.push({ documentId: id, requestId: request.requestId, documentVersion: request.documentVersion,
        text: request.text, format: request.format, ...(request.newlineMap ? { newlineMap: request.newlineMap } : {}),
        expectedDiskRevision: document.source.metadata.diskRevision });
    }
    return { ok: true, value: snapshots };
  }

  markTrashed(result: TrashEntryResult) {
    for (const id of result.missingDocumentIds) {
      const document = this.documents.get(id);
      if (!document) continue;
      const draft = result.drafts.find(item => item.documentId === id);
      if (!document.fragment) document.source = null;
      document.summary = { ...document.summary, missing: true,
        dirty: document.fragment ? document.summary.dirty : true,
        recoveryProtected: draft?.documentVersion === document.summary.version };
    }
    this.publish(this.snapshot.activeId);
  }

  commit(id: DocumentId, transactions: readonly Transaction[]): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    let state = document.state;
    let changes = 0;
    let characterCount = document.characterCount;
    // Validate the entire batch before committing any part of it.
    for (const transaction of transactions) {
      if (transaction.startState !== state) return failure('CONFLICT', '文档版本已变化，请重试操作。');
      if (transaction.docChanged && document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
      if (transaction.docChanged) {
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          characterCount += countCharacters(inserted.toString())
            - countCharacters(transaction.startState.sliceDoc(fromA, toA));
        });
      }
      state = transaction.state;
      if (transaction.docChanged) changes++;
    }
    document.state = state;
    document.characterCount = characterCount;
    this.publishMetrics(id, state, characterCount);
    if (changes > 0) {
      document.summary = {
        ...document.summary, version: document.summary.version + changes,
        dirty: document.summary.missing || !state.doc.eq(document.savedText), recoveryProtected: false,
      };
      this.publish(this.snapshot.activeId);
    }
    return { ok: true, value: { version: document.summary.version } };
  }

  private publishMetrics(id: DocumentId, state: EditorState, characterCount: number) {
    const next = editorMetrics(state, characterCount);
    const previous = this.metrics.get(id);
    if (previous && previous.line === next.line && previous.column === next.column
      && previous.characterCount === next.characterCount
      && previous.selectedCharacterCount === next.selectedCharacterCount
      && previous.selectionCount === next.selectionCount) return;
    this.metrics.set(id, next);
    const listeners = this.metricsListeners.get(id);
    if (listeners) queueMicrotask(() => {
      if (this.metricsListeners.get(id) === listeners) listeners.forEach(listener => listener());
    });
  }

  private scheduleLanguage(id: DocumentId) {
    const document = this.documents.get(id);
    if (!document) return;
    const languageId = document.summary.languageId;
    const generation = (this.languageGenerations.get(id) ?? 0) + 1;
    this.languageGenerations.set(id, generation);
    if (languageId === 'plaintext') return;
    void import('./language-loader').then(module => module.loadLanguageExtension(languageId)).then(language => {
      const current = this.documents.get(id);
      if (!current || this.languageGenerations.get(id) !== generation || current.summary.languageId !== languageId) return;
      current.state = reconfigureLanguage(current.state, language);
      current.summary = { ...current.summary, languageRevision: current.summary.languageRevision + 1 };
      this.publish(this.snapshot.activeId);
    }).catch(() => {
      // The local bundle could be unavailable after a damaged installation. Plain text remains usable.
    });
  }

  private publish(activeId: DocumentId | null) {
    this.snapshot = { documents: [...this.documents.values()].map(document => document.summary), activeId };
    this.listeners.forEach(listener => listener());
  }
}

export const documents = new DocumentRegistry();

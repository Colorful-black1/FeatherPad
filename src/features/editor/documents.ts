import { EditorSelection, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { documentFormat, formatState, sameDocumentFormat, setDocumentFormat, type DocumentFormatState, type Newline } from './line-endings';
import { encodingIds, type EncodingId } from '../../shared/contracts/encoding';
import type { Command, EditorView } from '@codemirror/view';
import type { DocumentId, LoadedRecoveryEntry, OpenDocument, RenamedDocument, ResultEnvelope, SaveAck, SaveAsAck, SaveRequest, TextFormat, TrashEntryResult, WriteRecoverySnapshotRequest } from '../../shared/contracts/files';
import { createEditorState, reconfigureBracketMatching, reconfigureCloseBrackets, reconfigureIndentation,
  reconfigureLanguage, reconfigureReadOnly, reconfigureEditorPreferences, reconfigureEditingBindings,
  defaultEditorPreferences,
  setSearchHighlights, type EditorPreferences, type IndentWidth } from './editor-state';
import { defaultEditingCommandBindings, type EditingCommandBindings } from './editing';
import { countCharacters, editorMetrics, type EditorMetrics } from './editor-metrics';
import { detectLanguage, type LanguageId } from './editor-language';
import { captureExisting, captureDestination, captureRecovery, acknowledgeExisting, acknowledgeDestination, readOnlyReason,
  type CapturedSave, type CapturedSaveAs } from './document-save-state';
import type { LoadedSaveTransaction } from '../../shared/contracts/files';
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
  recoveryError: string | null;
  recovered: boolean;
  closing: boolean;
  hotExitFrozen: boolean;
  readOnlyReason: string | null;
  canSaveAs: boolean;
  indentWidth: IndentWidth;
  indentOverridden: boolean;
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
  savedFormat: DocumentFormatState;
  source: Omit<OpenDocument, 'content'> | null;
  originalNewlines: NonNullable<SaveRequest['newlineMap']>;
  fragment: Exclude<OpenDocument['content'], { kind: 'text' }> | null;
  scroll: { top: number; left: number };
  characterCount: number;
  hasRecoveryData: boolean;
  recoveryReceiptId: string | null;
  releaseUncertain: boolean;
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

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY' | 'UNSUPPORTED' | 'INVALID_INPUT' | 'BUSY', message: string): ResultEnvelope<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

const isPlainTextMode = (mode: OpenDocument['mode'] | undefined) => mode === 'degraded' || mode === 'text-preview';
const textPreviewReason = '只读文本试开仅供查看，显示内容不能保存、另存、保存副本或覆盖源文件。';

function previewPreferences(state: EditorState, mode: OpenDocument['mode'] | undefined, preferences: EditorPreferences): EditorPreferences {
  if (mode === 'text-preview') {
    for (const line of state.doc.iterLines()) {
      if (line.length > 100_000) return { ...preferences, wordWrap: false };
    }
  }
  return preferences;
}

export class DocumentRegistry {
  private readonly documents = new Map<DocumentId, ManagedDocument>();
  private readonly listeners = new Set<() => void>();
  private readonly sessionListeners = new Set<() => void>();
  private readonly metrics = new Map<DocumentId, EditorMetrics>();
  private readonly metricsListeners = new Map<DocumentId, Set<() => void>>();
  private readonly languageGenerations = new Map<DocumentId, number>();
  private readonly views = new Map<DocumentId, Set<EditorView>>();
  private readonly viewScrolls = new WeakMap<EditorView, { top: number; left: number }>();
  private snapshot: RegistrySnapshot = { documents: [], activeId: null };
  private untitledCount = 0;
  private hotExitFrozen = false;
  private editorPreferences: EditorPreferences = { ...defaultEditorPreferences };
  private commandBindings: EditingCommandBindings = defaultEditingCommandBindings;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly subscribeSession = (listener: () => void) => {
    this.sessionListeners.add(listener);
    return () => { this.sessionListeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  getDocument(id: DocumentId): Readonly<ManagedDocument> | undefined {
    return this.documents.get(id);
  }

  getMetrics(id: DocumentId): EditorMetrics | null {
    return this.metrics.get(id) ?? null;
  }

  runEditorCommand(id: DocumentId, command: Command): boolean {
    const views = this.views.get(id);
    if (!views || views.size === 0) return false;
    const view = [...views].find(candidate => candidate.hasFocus) ?? views.values().next().value;
    if (!view) return false;
    view.focus();
    return command(view);
  }

  focusOffset(id: DocumentId, offset: number, extend = false): boolean {
    const document = this.documents.get(id);
    if (!document) return false;
    const position = Math.max(0, Math.min(document.state.doc.length, Math.trunc(offset)));
    const views = this.views.get(id);
    const view = views ? [...views].find(candidate => candidate.hasFocus) ?? views.values().next().value : undefined;
    if (view) {
      const current = view.state.selection.main;
      view.dispatch({
        selection: extend ? EditorSelection.range(current.anchor, position) : EditorSelection.cursor(position),
        scrollIntoView: true,
      });
      view.focus();
      return true;
    }
    document.state = document.state.update({
      selection: extend ? EditorSelection.range(document.state.selection.main.anchor, position)
        : EditorSelection.cursor(position),
    }).state;
    (this.views.get(id) ?? new Set<EditorView>()).forEach(candidate => candidate.setState(document.state));
    return true;
  }

  attachView(id: DocumentId, view: EditorView) {
    const views = this.views.get(id) ?? new Set<EditorView>();
    views.add(view);
    this.views.set(id, views);
    const document = this.documents.get(id);
    if (document) this.restoreViewScroll(id, view, this.viewScrolls.get(view) ?? document.scroll);
    return () => {
      views.delete(view);
      if (views.size === 0) this.views.delete(id);
    };
  }

  private restoreViewScroll(id: DocumentId, view: EditorView, scroll: { top: number; left: number }) {
    view.requestMeasure({
      read: () => scroll,
      write: position => {
        if (!this.views.get(id)?.has(view)) return;
        view.scrollDOM.scrollTop = position.top;
        view.scrollDOM.scrollLeft = position.left;
      },
    });
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
    const state = createEditorState('', this.hotExitFrozen, {
      ...this.editorPreferences, languageId: 'plaintext', commandBindings: this.commandBindings,
    });
    const summary: DocumentSummary = {
      id, title: `无标题 ${++this.untitledCount}`, displayPath: null,
      format: { encoding: 'utf-8', bom: 'none', lineEnding: 'crlf' },
      version: 0, dirty: false, missing: false, recoveryProtected: false, recoveryError: null, recovered: false,
      closing: false, hotExitFrozen: this.hotExitFrozen, readOnlyReason: null,
      canSaveAs: true, indentWidth: this.editorPreferences.indentWidth, indentOverridden: false,
      languageId: 'plaintext', languageSource: 'auto',
      languageRevision: 0, bracketMatching: true, closeBrackets: true,
    };
    this.documents.set(id, {
      summary, state, savedText: state.doc, savedVersion: 0, savedFormat: state.field(documentFormat), source: null,
      originalNewlines: { documentVersion: 0, endings: [] }, fragment: null, scroll: { top: 0, left: 0 },
      characterCount: 0, hasRecoveryData: false, recoveryReceiptId: null, releaseUncertain: false,
    });
    this.publishMetrics(id, state, 0);
    this.publish(id);
    return id;
  }

  openTransactionDraft(loaded: LoadedSaveTransaction): DocumentId {
    const id = this.createUntitled();
    const document = this.documents.get(id)!;
    const reason = readOnlyReason({ isReadOnly: false }, loaded.format);
    const languageId = detectLanguage(loaded.displayName);
    document.state = createEditorState(loaded.text, this.hotExitFrozen || reason !== null,
      { ...this.editorPreferences, languageId, commandBindings: this.commandBindings,
        documentFormat: formatState(loaded.format, loaded.newlineMap.endings) });
    document.originalNewlines = { documentVersion: 1, endings: [...loaded.newlineMap.endings] };
    document.characterCount = countCharacters(loaded.text);
    document.summary = { ...document.summary, title: `${loaded.displayName}（恢复副本）`,
      format: loaded.format, version: 1, dirty: true, recovered: true, readOnlyReason: reason,
      languageId };
    this.scheduleLanguage(id);
    this.publishMetrics(id, document.state, document.characterCount);
    this.publish(id);
    return id;
  }

  openDocument(document: OpenDocument): DocumentId {
    const id = document.documentId;
    if (!this.documents.has(id)) {
      const fragment = document.content.kind === 'text' ? null : document.content;
      const reason = document.mode === 'text-preview' ? textPreviewReason : fragment
        ? document.content.kind === 'chunked'
          ? '大文件以只读分块方式打开，无法保存完整文件'
          : '内容为前1MiB截断预览，无法保存'
        : readOnlyReason(document.metadata, document.format);
      const initialText = document.content.kind === 'text'
        ? document.content.text
        : document.content.kind === 'chunked'
          ? document.content.initialChunk.text
          : document.content.text;
      const languageId = isPlainTextMode(document.mode) ? 'plaintext' : detectLanguage(document.metadata.displayPath);
      const initialState = createEditorState(initialText, this.hotExitFrozen || reason !== null,
        { ...this.editorPreferences, languageId, commandBindings: this.commandBindings,
          ...(document.content.kind === 'text'
            ? { documentFormat: formatState(document.format, document.content.newlineMap.endings) } : {}) });
      const state = document.mode === 'text-preview'
        ? reconfigureEditorPreferences(initialState, previewPreferences(initialState, document.mode, this.editorPreferences))
        : initialState;
      const newlineMap = document.content.kind === 'text'
        ? document.content.newlineMap
        : { documentVersion: 0 as const, endings: [] as ('lf' | 'crlf' | 'cr')[] };
      const source = {
        documentId: document.documentId,
        ...(document.canonicalIdentity === undefined ? {} : { canonicalIdentity: document.canonicalIdentity }),
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
          version: newlineMap.documentVersion, dirty: false, missing: false, recoveryProtected: false,
          recoveryError: null, recovered: false, closing: false, hotExitFrozen: this.hotExitFrozen,
          readOnlyReason: reason,
          canSaveAs: fragment === null, indentWidth: 4, indentOverridden: false, languageId, languageSource: 'auto',
          languageRevision: 0, bracketMatching: true, closeBrackets: true,
        },
        state, savedText: state.doc, savedVersion: newlineMap.documentVersion, savedFormat: state.field(documentFormat), source,
        originalNewlines: newlineMap, fragment, scroll: { top: 0, left: 0 },
        characterCount: countCharacters(initialText), hasRecoveryData: false, recoveryReceiptId: null,
        releaseUncertain: false,
      });
      this.scheduleLanguage(id);
      this.publishMetrics(id, state, this.documents.get(id)!.characterCount);
    }
    // An alias/reopen only focuses. Incoming disk text never overwrites an existing buffer.
    this.activate(id);
    return id;
  }

  openRecovered(
    loaded: LoadedRecoveryEntry,
    sourceDocument?: OpenDocument,
    diskChanged = false,
  ): DocumentId {
    const id = loaded.entry.documentId;
    if (sourceDocument) {
      if (sourceDocument.documentId !== id
        || (sourceDocument.mode !== 'normal' && sourceDocument.mode !== 'degraded')) {
        return id;
      }
      this.openDocument(sourceDocument);
    }
    const text = loaded.text;
    const defaultEnding = loaded.entry.format.lineEnding === 'lf' ? 'lf' : 'crlf';
    const newlineMap = loaded.entry.newlineMap ?? {
      documentVersion: loaded.entry.bufferVersion,
      endings: Array.from({ length: text.split('\n').length - 1 }, () => defaultEnding as 'lf' | 'crlf'),
    };
    const existing = this.documents.get(id);
    const formatReadOnly = readOnlyReason(
      { isReadOnly: sourceDocument?.metadata.isReadOnly ?? false },
      loaded.entry.format,
    );
    const readOnly = diskChanged
      ? '磁盘内容在应用关闭期间发生变化；恢复副本保持只读，请比较后另存或明确覆盖。'
      : formatReadOnly;
    const state = createEditorState(text, this.hotExitFrozen || readOnly !== null,
      { ...this.editorPreferences, languageId: detectLanguage(loaded.entry.sourcePath ?? sourceDocument?.metadata.displayPath ?? ''),
        commandBindings: this.commandBindings,
        documentFormat: formatState(loaded.entry.format, newlineMap.endings) });
    const displayPath = sourceDocument?.metadata.displayPath ?? loaded.entry.sourcePath;
    const title = displayPath?.split(/[\\/]/).pop() || `恢复的无标题 ${++this.untitledCount}`;
    const characterCount = countCharacters(text);
    this.documents.set(id, {
      summary: {
        id, title, displayPath, format: loaded.entry.format,
        version: loaded.entry.bufferVersion, dirty: true,
        missing: sourceDocument === undefined && displayPath !== null,
        recoveryProtected: true, recoveryError: null, recovered: true,
        closing: false, hotExitFrozen: this.hotExitFrozen, readOnlyReason: readOnly, canSaveAs: true,
        indentWidth: 4, indentOverridden: false, languageId: detectLanguage(displayPath ?? title), languageSource: 'auto',
        languageRevision: 0, bracketMatching: true, closeBrackets: true,
      },
      state,
      savedText: existing?.savedText ?? state.doc,
      savedVersion: existing?.savedVersion ?? 0,
      savedFormat: existing?.savedFormat ?? state.field(documentFormat),
      source: existing?.source ?? null,
      originalNewlines: { documentVersion: loaded.entry.bufferVersion, endings: [...newlineMap.endings] },
      fragment: null, scroll: { top: 0, left: 0 },
      characterCount, hasRecoveryData: true, recoveryReceiptId: loaded.entry.receiptId, releaseUncertain: false,
    });
    this.scheduleLanguage(id);
    this.publishMetrics(id, state, characterCount);
    this.publish(id);
    return id;
  }

  activate(id: DocumentId) {
    if (this.documents.has(id) && this.snapshot.activeId !== id) this.publish(id);
  }

  beginHotExit(): readonly DocumentId[] {
    this.hotExitFrozen = true;
    for (const document of this.documents.values()) {
      document.state = reconfigureReadOnly(document.state, true);
      document.summary = { ...document.summary, hotExitFrozen: true };
    }
    this.publish(this.snapshot.activeId);
    return this.snapshot.documents.map(document => document.id);
  }

  cancelHotExit() {
    if (!this.hotExitFrozen) return;
    this.hotExitFrozen = false;
    for (const document of this.documents.values()) {
      document.state = reconfigureReadOnly(document.state, document.summary.readOnlyReason !== null);
      document.summary = { ...document.summary, hotExitFrozen: false };
    }
    this.publish(this.snapshot.activeId);
  }

  isHotExitFrozen() {
    return this.hotExitFrozen;
  }

  beginClose(id: DocumentId, version: number): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.closing) return failure('BUSY', '文档正在关闭，请等待。');
    if (document.summary.version !== version) return failure('CONFLICT', '文档已有新修改，请重新确认关闭。');
    if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) return failure('INVALID_INPUT', '文档版本无法安全关闭，请先保留副本。');
    document.state = reconfigureReadOnly(document.state, true);
    document.summary = { ...document.summary, closing: true };
    this.publish(this.snapshot.activeId);
    return { ok: true, value: { version } };
  }

  cancelClose(id: DocumentId, discardedThrough: number | null) {
    const document = this.documents.get(id);
    if (!document) return;
    const previousVersion = document.summary.version;
    const version = discardedThrough === null ? previousVersion : Math.max(previousVersion, discardedThrough + 1);
    document.summary = { ...document.summary, closing: false, version,
      recoveryProtected: discardedThrough === null ? document.summary.recoveryProtected : false,
      recoveryError: discardedThrough === null ? document.summary.recoveryError : null };
    if (document.originalNewlines.documentVersion === previousVersion) {
      document.originalNewlines = { ...document.originalNewlines, documentVersion: version };
    }
    document.state = reconfigureReadOnly(document.state, this.hotExitFrozen || document.summary.readOnlyReason !== null);
    this.publish(this.snapshot.activeId);
  }

  retainUncertainRelease(id: DocumentId, message?: string) {
    const document = this.documents.get(id);
    if (!document) return;
    document.releaseUncertain = true;
    if (!document.fragment) document.source = null;
    document.summary = { ...document.summary, readOnlyReason: message ?? (document.fragment
      ? '关闭结果尚未确认，已暂停分页；请重试关闭后重新打开。'
      : '关闭结果尚未确认，内容仍保留；请重试关闭或另存为。') };
    document.state = reconfigureReadOnly(document.state, true);
    this.publish(this.snapshot.activeId);
  }

  removeClosed(id: DocumentId, version: number): ResultEnvelope<{ closed: true }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    if (!document.summary.closing || document.summary.version !== version) return failure('CONFLICT', '关闭版本已变化，正文仍保留。');
    const ids = [...this.documents.keys()];
    const index = ids.indexOf(id);
    this.documents.delete(id);
    this.views.delete(id); // EditorDocument owns destruction of the mounted view.
    this.metrics.delete(id);
    this.metricsListeners.delete(id);
    this.languageGenerations.delete(id);
    const activeId = this.snapshot.activeId === id ? ids[index + 1] ?? ids[index - 1] ?? null : this.snapshot.activeId;
    this.publish(activeId);
    return { ok: true, value: { closed: true } };
  }

  setScroll(id: DocumentId, view: EditorView, top: number, left: number) {
    const document = this.documents.get(id);
    if (document && (document.scroll.top !== top || document.scroll.left !== left)) {
      this.viewScrolls.set(view, { top, left });
      document.scroll = { top, left };
      this.notifySession();
    }
  }

  restoreSessionState(id: DocumentId, selection: readonly { anchor: number; head: number }[],
    scrollTop: number, scrollLeft = 0, bufferVersion?: number) {
    const document = this.documents.get(id);
    if (!document || selection.length === 0) return false;
    const ranges = selection.slice(0, 16).map(range => EditorSelection.range(
      Math.max(0, Math.min(document.state.doc.length, range.anchor)),
      Math.max(0, Math.min(document.state.doc.length, range.head)),
    ));
    document.state = document.state.update({ selection: EditorSelection.create(ranges, 0) }).state;
    document.scroll = { top: Math.max(0, scrollTop), left: Math.max(0, scrollLeft) };
    for (const view of this.views.get(id) ?? []) {
      view.setState(document.state);
      this.restoreViewScroll(id, view, document.scroll);
    }
    if (!document.summary.dirty && bufferVersion !== undefined && Number.isSafeInteger(bufferVersion)
      && bufferVersion >= document.summary.version) {
      document.summary = { ...document.summary, version: bufferVersion };
      document.savedVersion = bufferVersion;
      document.originalNewlines = { ...document.originalNewlines, documentVersion: bufferVersion };
      this.publish(this.snapshot.activeId);
    }
    this.publishMetrics(id, document.state, document.characterCount);
    this.notifySession();
    return true;
  }

  reorder(ids: readonly DocumentId[]) {
    const ordered = new Map<DocumentId, ManagedDocument>();
    for (const id of ids) {
      const document = this.documents.get(id);
      if (document) ordered.set(id, document);
    }
    for (const [id, document] of this.documents) if (!ordered.has(id)) ordered.set(id, document);
    this.documents.clear();
    for (const [id, document] of ordered) this.documents.set(id, document);
    this.publish(this.snapshot.activeId);
  }

  selectRange(id: DocumentId, from: number, to: number, focus = true): boolean {
    const view = this.views.get(id)?.values().next().value;
    if (!view) return false;
    const anchor = Math.max(0, Math.min(view.state.doc.length, from));
    const head = Math.max(0, Math.min(view.state.doc.length, to));
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    if (focus) view.focus();
    return true;
  }

  focus(id: DocumentId): boolean {
    const view = this.views.get(id)?.values().next().value;
    if (!view) return false;
    view.focus();
    return true;
  }

  highlightSearch(id: DocumentId, ranges: readonly { from: number; to: number; current: boolean }[]) {
    const view = this.views.get(id)?.values().next().value;
    if (view) view.dispatch({ effects: setSearchHighlights.of(ranges) });
  }

  applyTextResult(id: DocumentId, expectedVersion: number, text: string, mappedEndings?: readonly Newline[]): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.readOnlyReason || document.fragment) return failure('READ_ONLY', '只读或限量预览不能应用文本工具。');
    if (document.summary.closing || document.summary.hotExitFrozen) return failure('BUSY', '文档正在安全关闭，当前内容保留。');
    if (document.summary.version !== expectedVersion) return failure('CONFLICT', '文档已变化，请重新生成预览。');
    if (text.includes('\r') || text.length >= 20 * 1024 * 1024) return failure('INVALID_INPUT', '结果换行无效或超过编辑工具预算。');
    const current = document.state.field(documentFormat);
    const count = text.split('\n').length - 1;
    const endings = mappedEndings ? [...mappedEndings] : Array.from({ length: count }, (_, index) => current.endings[index] ?? current.insertionEnding);
    if (endings.length !== count || endings.some(ending => !['lf', 'crlf', 'cr'].includes(ending))) return failure('INVALID_INPUT', '结果逐行换行映射无效。');
    if (document.state.doc.toString() === text && endings.every((ending, index) => ending === current.endings[index])) return { ok: true, value: { version: expectedVersion } };
    const selection = document.state.selection;
    const transaction = document.state.update({ changes: { from: 0, to: document.state.doc.length, insert: text },
      selection: EditorSelection.create(selection.ranges.map(range => EditorSelection.range(Math.min(range.anchor, text.length), Math.min(range.head, text.length))), selection.mainIndex),
      effects: setDocumentFormat.of({ ...current, endings }), annotations: isolateHistory.of('full') });
    const view = this.views.get(id)?.values().next().value;
    if (view) {
      view.dispatch(transaction);
      return document.state === transaction.state ? { ok: true, value: { version: document.summary.version } }
        : failure('CONFLICT', '文本工具结果未接受，当前正文保留。');
    }
    return this.commit(id, [transaction]);
  }

  replaceRanges(id: DocumentId, expectedVersion: number, changes: readonly BufferChange[]): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    const view = this.views.get(id)?.values().next().value;
    if (!document || !view) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
    if (document.summary.closing || document.summary.hotExitFrozen) return failure('BUSY', '文档正在安全关闭，当前内容保留。');
    if (document.summary.version !== expectedVersion) return failure('CONFLICT', '文档已变化，请重新查找后再替换。');
    let previousTo = -1;
    for (const change of changes) {
      if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
        || change.from < previousTo || change.to < change.from || change.to > view.state.doc.length) {
        return failure('INVALID_INPUT', '替换范围无效，请重新查找。');
      }
      previousTo = change.to;
    }
    view.dispatch({ changes: changes.map(change => ({ ...change })), annotations: isolateHistory.of('full') });
    const latest = this.documents.get(id);
    return latest ? { ok: true, value: { version: latest.summary.version } } : failure('NOT_FOUND', '文档已关闭。');
  }

  changeFormat(id: DocumentId, expectedVersion: number, format: TextFormat,
    replacements: readonly BufferChange[] = []): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.version !== expectedVersion) return failure('CONFLICT', '文档已变化，请重新确认转换。');
    if (document.fragment || document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason ?? '只读预览不能转换。');
    if (!encodingIds.includes(format.encoding as EncodingId)
      || !['lf', 'crlf', 'mixed'].includes(format.lineEnding)
      || (format.bom !== 'none' && format.bom !== ({ 'utf-8': 'utf8', 'utf-16le': 'utf16le', 'utf-16be': 'utf16be' } as Record<string, string>)[format.encoding])) {
      return failure('INVALID_INPUT', '编码、BOM或换行格式无效。');
    }
    let end = 0;
    for (const replacement of replacements) {
      if (!Number.isSafeInteger(replacement.from) || !Number.isSafeInteger(replacement.to)
        || replacement.from < end || replacement.to <= replacement.from || replacement.to > document.state.doc.length
        || replacement.insert !== '?' || document.state.sliceDoc(replacement.from, replacement.to).includes('\n')) {
        return failure('INVALID_INPUT', '有损替代范围无效，正文未修改。');
      }
      end = replacement.to;
    }
    const current = document.state.field(documentFormat);
    const endings = format.lineEnding === 'mixed' ? current.endings
      : current.endings.map(() => format.lineEnding as 'lf' | 'crlf');
    const next = formatState(format, endings);
    if (sameDocumentFormat(current, next) && replacements.length === 0) return { ok: true, value: { version: expectedVersion } };
    const transaction = document.state.update({ effects: setDocumentFormat.of(next),
      changes: replacements.map(change => ({ ...change })), annotations: isolateHistory.of('full') });
    const view = this.views.get(id)?.values().next().value;
    if (view) {
      view.dispatch(transaction);
      return document.state === transaction.state ? { ok: true, value: { version: document.summary.version } }
        : failure('CONFLICT', '转换未接受，原正文仍保留。');
    }
    return this.commit(id, [transaction]);
  }

  setIndentWidth(id: DocumentId, indentWidth: IndentWidth) {
    const document = this.documents.get(id);
    if (!document || (document.summary.indentWidth === indentWidth && document.summary.indentOverridden)) return;
    document.state = reconfigureIndentation(document.state, indentWidth, this.editorPreferences.insertSpaces);
    document.summary = { ...document.summary, indentWidth, indentOverridden: true };
    this.publish(this.snapshot.activeId);
  }

  clearIndentOverride(id: DocumentId) {
    const document = this.documents.get(id);
    if (!document || !document.summary.indentOverridden) return;
    document.summary = { ...document.summary, indentOverridden: false };
    this.applyEditorPreferences(this.editorPreferences);
    this.publish(this.snapshot.activeId);
  }

  applyEditorPreferences(preferences: EditorPreferences) {
    this.editorPreferences = { ...preferences };
    let changed = false;
    for (const [id, document] of this.documents) {
      const indentWidth = document.summary.indentOverridden ? document.summary.indentWidth : preferences.indentWidth;
      const next = reconfigureEditorPreferences(document.state, previewPreferences(document.state, document.source?.mode, { ...preferences, indentWidth }));
      if (next === document.state) continue;
      document.state = next;
      document.summary = { ...document.summary, indentWidth };
      for (const view of this.views.get(id) ?? []) {
        view.setState(next);
        this.restoreViewScroll(id, view, document.scroll);
      }
      changed = true;
    }
    if (changed) this.publish(this.snapshot.activeId);
  }

  applyCommandBindings(bindings: EditingCommandBindings) {
    const normalized = Object.fromEntries(Object.entries(bindings)
      .filter((entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null));
    if (JSON.stringify(normalized) === JSON.stringify(this.commandBindings)) return;
    this.commandBindings = normalized;
    let changed = false;
    for (const [id, document] of this.documents) {
      const next = reconfigureEditingBindings(document.state, normalized);
      if (next === document.state) continue;
      document.state = next;
      for (const view of this.views.get(id) ?? []) view.setState(next);
      changed = true;
    }
    if (changed) this.publish(this.snapshot.activeId);
  }

  setLanguage(id: DocumentId, selection: 'auto' | LanguageId) {
    const document = this.documents.get(id);
    if (!document) return;
    const languageId = selection === 'auto'
      ? isPlainTextMode(document.source?.mode) ? 'plaintext' : detectLanguage(document.summary.displayPath)
      : selection;
    const languageSource = selection === 'auto' ? 'auto' : 'manual';
    if (document.summary.languageId === languageId && document.summary.languageSource === languageSource) return;
    document.summary = {
      ...document.summary, languageId, languageSource, languageRevision: document.summary.languageRevision + 1,
    };
    document.state = reconfigureLanguage(document.state, [], languageId, this.editorPreferences.folding);
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

  markExternalMissing(id: DocumentId) {
    const document = this.documents.get(id);
    if (!document || document.summary.missing) return;
    // Retain the ref for later stat/reappearance. Even a clean full buffer now needs
    // recovery protection because its source path no longer holds these bytes.
    document.summary = { ...document.summary, missing: true,
      dirty: document.fragment ? document.summary.dirty : true, recoveryProtected: false };
    this.publish(this.snapshot.activeId);
  }

  applyDiskReload(opened: OpenDocument, expectedVersion: number, expectedRevision: string,
    allowDirty = false): ResultEnvelope<{ reloaded: true }> {
    const document = this.documents.get(opened.documentId);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    if (document.summary.version !== expectedVersion || document.source?.metadata.diskRevision !== expectedRevision
      || document.source.ref.grantId !== opened.ref.grantId || document.source.ref.relativePath !== opened.ref.relativePath
      || document.summary.closing || document.summary.hotExitFrozen || document.releaseUncertain
      || (document.summary.dirty && (!allowDirty || !document.summary.recoveryProtected))) {
      return failure('CONFLICT', '读取期间缓冲已变化，当前输入仍保留，请重新核对。');
    }
    if (!Number.isSafeInteger(expectedVersion + 1)) return failure('INVALID_INPUT', '文档版本超出可用范围，请另存。');
    const text = opened.content.kind === 'text' ? opened.content.text
      : opened.content.kind === 'chunked' ? opened.content.initialChunk.text : opened.content.text;
    const fragment = opened.content.kind === 'text' ? null : opened.content;
    const reason = opened.mode === 'text-preview' ? textPreviewReason : fragment ? '磁盘文件以只读预览方式打开，无法保存完整文件'
      : readOnlyReason(opened.metadata, opened.format);
    const previousSelection = document.state.selection.ranges;
    const version = expectedVersion + 1;
    document.state = createEditorState(text, reason !== null, { ...this.editorPreferences,
      ...document.summary, languageId: document.summary.languageId, commandBindings: this.commandBindings,
      ...(opened.content.kind === 'text' ? { documentFormat: formatState(opened.format, opened.content.newlineMap.endings) } : {}) });
    if (opened.mode === 'text-preview') {
      document.state = reconfigureEditorPreferences(document.state, previewPreferences(document.state, opened.mode, this.editorPreferences));
    }
    document.state = document.state.update({ selection: EditorSelection.create(previousSelection.map(range =>
      EditorSelection.range(Math.min(range.anchor, text.length), Math.min(range.head, text.length)))) }).state;
    document.savedText = document.state.doc;
    document.savedVersion = version;
    document.savedFormat = document.state.field(documentFormat);
    document.source = { documentId: opened.documentId,
      ...(opened.canonicalIdentity === undefined ? {} : { canonicalIdentity: opened.canonicalIdentity }),
      ref: opened.ref, metadata: opened.metadata, mode: opened.mode, format: opened.format,
      warnings: opened.warnings };
    document.fragment = fragment;
    document.originalNewlines = { documentVersion: version,
      endings: opened.content.kind === 'text' ? [...opened.content.newlineMap.endings] : [] };
    document.characterCount = countCharacters(text);
    document.summary = { ...document.summary, version, dirty: false, missing: false, recovered: false,
      recoveryProtected: false, recoveryError: null, readOnlyReason: reason, canSaveAs: fragment === null,
      format: opened.format, displayPath: opened.metadata.displayPath,
      title: opened.metadata.displayPath.split(/[\\/]/).pop() || opened.metadata.displayPath,
      languageId: isPlainTextMode(opened.mode) ? 'plaintext' : document.summary.languageSource === 'auto'
        ? detectLanguage(opened.metadata.displayPath) : document.summary.languageId };
    for (const view of this.views.get(opened.documentId) ?? []) {
      view.setState(document.state);
      this.restoreViewScroll(opened.documentId, view, document.scroll);
    }
    this.scheduleLanguage(opened.documentId);
    this.publishMetrics(opened.documentId, document.state, document.characterCount);
    this.publish(this.snapshot.activeId);
    return { ok: true, value: { reloaded: true } };
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
        const languageId = isPlainTextMode(document.source?.mode) ? 'plaintext' : detectLanguage(document.summary.displayPath);
        if (languageId !== document.summary.languageId) {
          document.summary = {
            ...document.summary, languageId, languageRevision: document.summary.languageRevision + 1,
          };
          document.state = reconfigureLanguage(document.state, [], languageId, this.editorPreferences.folding);
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
        const languageId = isPlainTextMode(document.source.mode) ? 'plaintext' : detectLanguage(mapping.displayPath);
        if (languageId !== document.summary.languageId) {
          document.summary = {
            ...document.summary,
            languageId,
            languageRevision: document.summary.languageRevision + 1,
          };
          document.state = reconfigureLanguage(document.state, [], languageId, this.editorPreferences.folding);
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
      if (draft) {
        document.hasRecoveryData = true;
        document.recoveryReceiptId = draft.receiptId;
      }
      if (!document.fragment) document.source = null;
      document.summary = { ...document.summary, missing: true,
        dirty: document.fragment ? document.summary.dirty : true,
        recoveryProtected: draft?.documentVersion === document.summary.version,
        recoveryError: draft?.documentVersion === document.summary.version ? null : document.summary.recoveryError };
    }
    this.publish(this.snapshot.activeId);
  }

  commit(id: DocumentId, transactions: readonly Transaction[], sourceView?: EditorView): ResultEnvelope<{ version: number }> {
    const document = this.documents.get(id);
    if (!document) return failure('NOT_FOUND', '文档已关闭。');
    let state = document.state;
    let changes = 0;
    let characterCount = document.characterCount;
    // Validate the entire batch before committing any part of it.
    for (const transaction of transactions) {
      if (!transaction.startState.doc.eq(state.doc)) return failure('CONFLICT', '文档版本已变化，请重试操作。');
      const modified = transaction.docChanged || !sameDocumentFormat(state.field(documentFormat), transaction.state.field(documentFormat));
      if (modified && document.summary.closing) return failure('BUSY', '文档正在关闭，这次修改尚未接受。');
      if (modified && document.summary.hotExitFrozen) {
        return failure('BUSY', '应用正在准备安全退出，这次修改尚未接受。');
      }
      if (modified && document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
      if (transaction.docChanged) {
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          characterCount += countCharacters(inserted.toString())
            - countCharacters(transaction.startState.sliceDoc(fromA, toA));
        });
      }
      state = transaction.state;
      if (modified) changes++;
    }
    document.state = state;
    document.characterCount = characterCount;
    this.publishMetrics(id, state, characterCount);
    this.notifySession();
    if (changes > 0) {
      const currentFormat = state.field(documentFormat);
      document.summary = {
        ...document.summary, version: document.summary.version + changes,
        format: { ...currentFormat.format },
        dirty: document.summary.missing || document.summary.recovered || !state.doc.eq(document.savedText)
          || !sameDocumentFormat(currentFormat, document.savedFormat),
        recoveryProtected: false, recoveryError: null,
      };
      document.originalNewlines = { documentVersion: document.summary.version, endings: currentFormat.endings };
      document.recoveryReceiptId = null;
      this.publish(this.snapshot.activeId);
      for (const view of this.views.get(id) ?? []) {
        if (view === sourceView || view.state.doc.eq(state.doc)) continue;
        const main = view.state.selection.main;
        let anchor = main.anchor;
        let head = main.head;
        for (const transaction of transactions) {
          if (!transaction.docChanged) continue;
          anchor = transaction.changes.mapPos(anchor, -1);
          head = transaction.changes.mapPos(head, 1);
        }
        view.setState(state.update({
          selection: EditorSelection.single(
            Math.min(anchor, state.doc.length),
            Math.min(head, state.doc.length),
          ),
        }).state);
      }
    }
    return { ok: true, value: { version: document.summary.version } };
  }

  captureRecovery(id: DocumentId,
    reason: WriteRecoverySnapshotRequest['reason'] = 'periodic'): ResultEnvelope<WriteRecoverySnapshotRequest> {
    return captureRecovery(this.documents.get(id), reason);
  }

  acknowledgeRecovery(id: DocumentId, version: number, receiptId: string): boolean {
    const document = this.documents.get(id);
    if (!document || document.summary.version !== version || !document.summary.dirty) return false;
    document.hasRecoveryData = true;
    document.recoveryReceiptId = receiptId;
    document.summary = { ...document.summary, recoveryProtected: true, recoveryError: null };
    this.publish(this.snapshot.activeId);
    return true;
  }

  markRecoveryFailure(id: DocumentId, version: number, message: string): boolean {
    const document = this.documents.get(id);
    if (!document || document.summary.version !== version || !document.summary.dirty) return false;
    document.summary = { ...document.summary, recoveryProtected: false, recoveryError: message };
    this.publish(this.snapshot.activeId);
    return true;
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
      current.state = reconfigureLanguage(current.state, language, languageId, this.editorPreferences.folding);
      current.summary = { ...current.summary, languageRevision: current.summary.languageRevision + 1 };
      this.publish(this.snapshot.activeId);
    }).catch(() => {
      // The local bundle could be unavailable after a damaged installation. Plain text remains usable.
    });
  }

  private publish(activeId: DocumentId | null) {
    this.snapshot = { documents: [...this.documents.values()].map(document => document.summary), activeId };
    this.listeners.forEach(listener => listener());
    this.notifySession();
  }

  private notifySession() {
    this.sessionListeners.forEach(listener => listener());
  }
}

export const documents = new DocumentRegistry();

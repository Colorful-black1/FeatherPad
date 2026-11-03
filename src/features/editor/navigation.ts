import type { EditorState } from '@codemirror/state';
import type { DocumentId } from '../../shared/contracts/files';
import type { LanguageId } from './editor-language';

export interface NavigationTarget {
  documentId: DocumentId;
  offset: number;
  label: string;
}

export interface NavigationAvailability {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly size: number;
}

export class NavigationHistory {
  private readonly entries: NavigationTarget[] = [];
  private readonly listeners = new Set<() => void>();
  private index = -1;
  private snapshot: NavigationAvailability = Object.freeze({ canGoBack: false, canGoForward: false, size: 0 });

  constructor(private readonly limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Navigation history limit must be 1–100.');
  }

  record(target: NavigationTarget) {
    const normalized = { ...target, offset: Math.max(0, Math.trunc(target.offset)) };
    if (this.index >= 0 && this.entries[this.index]?.documentId === normalized.documentId
      && this.entries[this.index]?.offset === normalized.offset) return;
    if (this.index < this.entries.length - 1) this.entries.splice(this.index + 1);
    this.entries.push(normalized);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
    this.publish();
  }

  back(): NavigationTarget | null {
    if (this.index <= 0) return null;
    this.index--;
    this.publish();
    return this.entries[this.index] ?? null;
  }

  forward(): NavigationTarget | null {
    if (this.index < 0 || this.index >= this.entries.length - 1) return null;
    this.index++;
    this.publish();
    return this.entries[this.index] ?? null;
  }

  removeDocument(documentId: DocumentId) {
    const current = this.entries[this.index];
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index]?.documentId !== documentId) continue;
      this.entries.splice(index, 1);
      if (index <= this.index) this.index--;
    }
    if (current && this.entries[this.index]?.documentId !== current.documentId) {
      this.index = Math.max(-1, Math.min(this.index, this.entries.length - 1));
    }
    this.publish();
  }

  retainDocuments(documentIds: ReadonlySet<DocumentId>) {
    for (const documentId of new Set(this.entries.map(entry => entry.documentId))) {
      if (!documentIds.has(documentId)) this.removeDocument(documentId);
    }
  }

  get canGoBack() { return this.index > 0; }
  get canGoForward() { return this.index >= 0 && this.index < this.entries.length - 1; }
  get size() { return this.entries.length; }
  get current() { return this.entries[this.index] ?? null; }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  private publish() {
    const next = { canGoBack: this.canGoBack, canGoForward: this.canGoForward, size: this.entries.length };
    if (next.canGoBack === this.snapshot.canGoBack && next.canGoForward === this.snapshot.canGoForward
      && next.size === this.snapshot.size) return;
    this.snapshot = Object.freeze(next);
    this.listeners.forEach(listener => listener());
  }
}

export interface LineColumn {
  line: number;
  column: number;
}

export function positionAt(state: EditorState, requested: LineColumn) {
  const lineNumber = Math.max(1, Math.min(state.doc.lines, Number.isFinite(requested.line) ? Math.trunc(requested.line) : 1));
  const line = state.doc.line(lineNumber);
  const column = Math.max(1, Math.min(line.length + 1, Number.isFinite(requested.column) ? Math.trunc(requested.column) : 1));
  return { offset: line.from + column - 1, line: lineNumber, column, clamped: lineNumber !== requested.line || column !== requested.column };
}

export function lineColumnAt(state: EditorState, offset: number): LineColumn {
  const line = state.doc.lineAt(Math.max(0, Math.min(state.doc.length, offset)));
  return { line: line.number, column: offset - line.from + 1 };
}

export interface OutlineItem {
  id: string;
  label: string;
  level: number;
  offset: number;
}

export function localOutline(languageId: LanguageId, text: string): OutlineItem[] {
  if (languageId === 'markdown') {
    const items: OutlineItem[] = [];
    let fence = false;
    let offset = 0;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const match = !fence ? /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line) : null;
      if (match) items.push({
        id: `md-${offset}`,
        label: match[2] ?? '',
        level: match[1]?.length ?? 1,
        offset,
      });
      offset += line.length + 1;
    }
    return items.slice(0, 2_000);
  }
  if (languageId === 'json' || languageId === 'jsonc') {
    const items: OutlineItem[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
      const match = /^(\s*)"((?:[^"\\]|\\.){1,256})"\s*:/.exec(line);
      if (match) items.push({
        id: `json-${offset}`,
        label: match[2] ?? '',
        level: Math.min(6, Math.max(1, Math.floor((match[1]?.replace(/\t/g, '  ').length ?? 0) / 2))),
        offset: offset + (line.length - line.trimStart().length),
      });
      offset += line.length + 1;
    }
    return items.slice(0, 2_000);
  }
  return [];
}

export function breadcrumbSegments(displayPath: string | null) {
  if (!displayPath) return [];
  const normalized = displayPath.replace(/\//g, '\\');
  const segments = normalized.split('\\').filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment,
    path: `${index === 0 && /^[A-Za-z]:$/.test(segment) ? '' : '\\'}${segments.slice(0, index + 1).join('\\')}`,
  }));
}

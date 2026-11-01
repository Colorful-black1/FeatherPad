export type DocumentId = string & { readonly __documentId: unique symbol };
export type GrantId = string & { readonly __grantId: unique symbol };
export type DiskRevision = string & { readonly __diskRevision: unique symbol };

export const errorCodes = [
  'NOT_FOUND', 'PERMISSION_DENIED', 'OUT_OF_SCOPE', 'IS_BINARY', 'TOO_LARGE',
  'CONFLICT', 'ENCODING_REQUIRED', 'LOSSY_ENCODING', 'DISK_FULL', 'READ_ONLY',
  'INVALID_INPUT', 'INVALID_PATTERN', 'CANCELLED', 'UNSUPPORTED', 'BUSY',
  'PARTIAL_FAILURE', 'IPC_UNAVAILABLE', 'INTERNAL',
] as const;

export interface AppError {
  code: typeof errorCodes[number];
  message: string;
  retryable: boolean;
}
export type ResultEnvelope<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface FileRef { grantId: GrantId; relativePath: string }
export interface ChosenFiles {
  grants: FileRef[];
  failures: { selectionIndex: number; error: AppError }[];
}
export interface TextFormat {
  encoding: string;
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be';
  lineEnding: 'lf' | 'crlf' | 'mixed';
}
export interface SaveRequest {
  readonly documentId: DocumentId;
  readonly requestId: string;
  readonly documentVersion: number;
  readonly expectedDiskRevision: DiskRevision;
  readonly text: string;
  readonly format: Readonly<TextFormat>;
  readonly newlineMap?: { readonly documentVersion: number; readonly endings: readonly ('lf' | 'crlf' | 'cr')[] };
}
export interface SaveAck {
  documentVersion: number;
  diskRevision: DiskRevision;
  savedAt: string;
  sizeBytes: number;
}
export interface SaveAsRequest extends Omit<SaveRequest, 'expectedDiskRevision'> {
  readonly intent?: 'save-as' | 'copy';
}
export interface SaveAsAck {
  documentId: DocumentId;
  ref: FileRef;
  metadata: OpenDocument['metadata'];
  ack: SaveAck;
}
export interface FileMetadata {
  displayPath: string;
  sizeBytes: number;
  modifiedAt: string;
  isReadOnly: boolean;
  diskRevision: DiskRevision;
}
export interface TextChunk {
  byteStart: number;
  byteEnd: number;
  firstLine: number;
  text: string;
  hasMore: boolean;
}
export interface OpenDocumentBase {
  documentId: DocumentId;
  ref: FileRef;
  metadata: FileMetadata;
  format: TextFormat;
  warnings: string[];
}
export type OpenDocument = OpenDocumentBase & (
  | {
    mode: 'normal' | 'degraded';
    content: {
      kind: 'text';
      text: string;
      newlineMap: { documentVersion: number; endings: ('lf' | 'crlf' | 'cr')[] };
    };
  }
  | {
    mode: 'large-readonly';
    content: {
      kind: 'chunked';
      handleId: string;
      initialChunk: TextChunk;
      totalBytes: number;
    };
  }
  | {
    mode: 'head-preview';
    content: {
      kind: 'head';
      text: string;
      previewBytes: number;
      totalBytes: number;
      truncated: true;
    };
  }
);
export interface ReadChunkRequest {
  documentId: DocumentId;
  handleId: string;
  expectedDiskRevision: DiskRevision;
  byteOffset: number;
  maxBytes: number;
}

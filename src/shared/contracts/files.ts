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
export interface TextFormat {
  encoding: string;
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be';
  lineEnding: 'lf' | 'crlf' | 'mixed';
}
export interface OpenDocument {
  documentId: DocumentId;
  ref: FileRef;
  metadata: {
    displayPath: string;
    sizeBytes: number;
    modifiedAt: string;
    isReadOnly: boolean;
    diskRevision: DiskRevision;
  };
  format: TextFormat;
  warnings: string[];
  mode: 'normal' | 'degraded';
  content: {
    kind: 'text';
    text: string;
    newlineMap: { documentVersion: number; endings: ('lf' | 'crlf' | 'cr')[] };
  };
}

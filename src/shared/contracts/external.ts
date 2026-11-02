import type { FileRef } from './files';

export interface FilesystemChanged {
  watchId: string;
  sequence: number;
  entries: { ref: FileRef; kind: 'changed' }[];
  overflow: boolean;
}

import { listen } from '@tauri-apps/api/event';
import type { DiskRevision, DocumentId, FileRef, SaveRequest } from '../shared/contracts/files';
import type { FilesystemChanged } from '../shared/contracts/external';
import { callCommand, isRecord } from './invoke';
import { isFileRef, isOpenDocument, isSaveAck } from './files';

export function isFilesystemChanged(value: unknown): value is FilesystemChanged {
  return isRecord(value) && typeof value.watchId === 'string' && value.watchId.length <= 128
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && typeof value.overflow === 'boolean' && Array.isArray(value.entries) && value.entries.length <= 256
    && value.entries.every(entry => isRecord(entry) && isFileRef(entry.ref) && entry.kind === 'changed'
      && !entry.ref.relativePath.includes('\0') && !/^[\\/]|:/.test(entry.ref.relativePath)
      && entry.ref.relativePath.split(/[\\/]/).every(segment => segment !== '..' && segment !== '.'));
}

export const externalFiles = {
  overwrite: (request: SaveRequest) => callCommand('overwrite_document', { ...request }, isSaveAck),
  snapshot: (documentId: DocumentId) => callCommand('get_disk_snapshot', { documentId },
    (value): value is import('../shared/contracts/files').OpenDocument => isOpenDocument(value) && value.documentId === documentId),
  reload: (documentId: DocumentId, expectedDiskRevision: DiskRevision) =>
    callCommand('reload_document', { documentId, expectedDiskRevision },
      (value): value is import('../shared/contracts/files').OpenDocument => isOpenDocument(value)
        && value.documentId === documentId && value.metadata.diskRevision === expectedDiskRevision),
  start: (refs: FileRef[]) => callCommand('start_watch', { refs },
    (value): value is { watchId: string } => isRecord(value) && typeof value.watchId === 'string' && value.watchId.length > 0 && value.watchId.length <= 128),
  stop: (watchId: string) => callCommand('stop_watch', { watchId },
    (value): value is { stopped: boolean } => isRecord(value) && typeof value.stopped === 'boolean'),
  listen: (receive: (event: FilesystemChanged) => void) => listen<unknown>('filesystem_changed', event => {
    if (isFilesystemChanged(event.payload)) receive(event.payload);
  }),
};

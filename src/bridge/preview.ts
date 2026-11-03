import type { DocumentId, FileRef } from '../shared/contracts/files';
import { callCommand, isRecord } from './invoke';
import { isFileRef, isSaveAsAck } from './files';

export interface ResourceRequest {
  documentId: DocumentId | null;
  directory: FileRef | null;
  url: string;
  maxBytes: number;
}
export interface ResourceImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';
  dataBase64: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export function isResourceImage(value: unknown): value is ResourceImage {
  if (!isRecord(value) || typeof value.mime !== 'string'
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(value.mime)
    || typeof value.dataBase64 !== 'string' || value.dataBase64.length > 28 * 1024 * 1024 || value.dataBase64.length % 4 !== 0
    || !/^[a-z\d+/]*={0,2}$/i.test(value.dataBase64)
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes <= 0 || value.sizeBytes > 20 * 1024 * 1024) return false;
  const decodedLength = value.dataBase64.length / 4 * 3 - (value.dataBase64.endsWith('==') ? 2 : value.dataBase64.endsWith('=') ? 1 : 0);
  if (decodedLength !== value.sizeBytes) return false;
  if (value.mime === 'image/svg+xml') return value.width === null && value.height === null;
  return typeof value.width === 'number' && Number.isSafeInteger(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isSafeInteger(value.height) && value.height > 0
    && value.width * value.height <= 40_000_000;
}

export const previewBridge = {
  exportHtml: (request: { documentId: DocumentId; requestId: string; documentVersion: number; html: string }) =>
    callCommand('export_html', { ...request }, isSaveAsAck),
  read: (request: ResourceRequest) => callCommand('read_preview_resource', { ...request }, isResourceImage),
  link: (request: Omit<ResourceRequest, 'maxBytes'>) => callCommand('authorize_preview_link', { ...request }, isFileRef),
  openExternal: (url: string) => callCommand('open_external_preview', { url, confirmed: true }, (value): value is boolean => typeof value === 'boolean'),
};

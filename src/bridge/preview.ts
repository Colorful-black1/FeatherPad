import type { DocumentId, FileRef } from '../shared/contracts/files';
import { callCommand, isRecord } from './invoke';
import { isFileRef, isSaveAsAck, isResourceImage } from './files';

export interface ResourceRequest {
  documentId: DocumentId | null;
  directory: FileRef | null;
  url: string;
  maxBytes: number;
}
export type { ResourceImage } from '../shared/contracts/files';
export { isResourceImage } from './files';

export interface PdfOptions { paper: 'a4' | 'letter'; landscape: boolean;
  marginsMm: { top: number; right: number; bottom: number; left: number } }
interface PdfAck { displayPath: string; sizeBytes: number; sha256: string }
function isPdfAck(value: unknown): value is PdfAck {
  return isRecord(value) && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 32767
    && typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= 100 * 1024 * 1024
    && typeof value.sha256 === 'string' && /^[a-f\d]{64}$/i.test(value.sha256);
}

export const previewBridge = {
  exportPdf: (request: { documentId: DocumentId; requestId: string; documentVersion: number; html: string; options: PdfOptions }) =>
    callCommand('export_pdf', { ...request }, isPdfAck),
  cancelPdf: (requestId: string) => callCommand('cancel_pdf_export', { requestId }, (value): value is boolean => typeof value === 'boolean'),
  exportHtml: (request: { documentId: DocumentId; requestId: string; documentVersion: number; html: string }) =>
    callCommand('export_html', { ...request }, isSaveAsAck),
  read: (request: ResourceRequest) => callCommand('read_preview_resource', { ...request }, isResourceImage),
  link: (request: Omit<ResourceRequest, 'maxBytes'>) => callCommand('authorize_preview_link', { ...request }, isFileRef),
  openExternal: (url: string) => callCommand('open_external_preview', { url, confirmed: true }, (value): value is boolean => typeof value === 'boolean'),
};

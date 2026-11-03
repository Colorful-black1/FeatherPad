import type { Text } from '@codemirror/state';
import type { DiskRevision, FileRef, ResultEnvelope, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest, TextFormat, WriteRecoverySnapshotRequest } from '../../shared/contracts/files';
import type { ManagedDocument } from './documents';
import { reconfigureReadOnly } from './editor-state';
import { documentFormat, sameDocumentFormat, type DocumentFormatState } from './line-endings';

export interface CapturedSave { readonly request: SaveRequest; readonly savedText: Text; readonly savedFormat: DocumentFormatState }
export interface CapturedSaveAs {
  readonly request: SaveAsRequest;
  readonly savedText: Text;
  readonly savedFormat: DocumentFormatState;
  readonly baseSource: { readonly ref: FileRef; readonly revision: DiskRevision } | null;
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'READ_ONLY' | 'UNSUPPORTED' | 'INVALID_INPUT', message: string): ResultEnvelope<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

export function readOnlyReason(metadata: { isReadOnly: boolean }, format: TextFormat): string | null {
  return metadata.isReadOnly ? '文件为只读' : format.lineEnding === 'mixed' ? '混合换行暂以只读方式打开'
    : format.encoding !== 'utf-8' ? '此编码暂以只读方式打开' : null;
}

function snapshot(document: ManagedDocument): ResultEnvelope<{ request: Omit<SaveAsRequest, 'intent'>; savedText: Text; savedFormat: DocumentFormatState }> {
  const { id, version, format } = document.summary;
  if (format.lineEnding === 'mixed' && document.originalNewlines.documentVersion !== version) {
    return failure('CONFLICT', '逐行换行映射与当前版本不一致，请保留原文并重试。');
  }
  const ending = format.lineEnding === 'lf' ? 'lf' : 'crlf';
  const endings = format.lineEnding === 'mixed' ? [...document.originalNewlines.endings]
    : Array.from({ length: document.state.doc.lines - 1 }, () => ending);
  return { ok: true, value: {
    savedText: document.state.doc,
    savedFormat: document.state.field(documentFormat),
    request: Object.freeze({ documentId: id, requestId: crypto.randomUUID(), documentVersion: version,
      text: document.state.doc.toString(), format: Object.freeze({ ...format }),
      newlineMap: Object.freeze({ documentVersion: version, endings: Object.freeze(endings) }),
    }),
  } };
}

export function captureExisting(document: ManagedDocument | undefined): ResultEnvelope<CapturedSave> {
  if (!document) return failure('NOT_FOUND', '文档已关闭。');
  if (document.summary.readOnlyReason) return failure('READ_ONLY', document.summary.readOnlyReason);
  if (!document.source) return failure('UNSUPPORTED', '此文档尚无文件路径，请使用另存为。');
  const captured = snapshot(document);
  if (!captured.ok) return captured;
  return { ok: true, value: Object.freeze({ savedText: captured.value.savedText, savedFormat: captured.value.savedFormat,
    request: Object.freeze({ ...captured.value.request, expectedDiskRevision: document.source.metadata.diskRevision }),
  }) };
}

export function captureDestination(document: ManagedDocument | undefined, intent: 'save-as' | 'copy'): ResultEnvelope<CapturedSaveAs> {
  if (!document) return failure('NOT_FOUND', '文档已关闭。');
  if (document.fragment) return failure('READ_ONLY', document.summary.readOnlyReason ?? '大文件片段不能另存。');
  const captured = snapshot(document);
  if (!captured.ok) return captured;
  return { ok: true, value: Object.freeze({ savedText: captured.value.savedText, savedFormat: captured.value.savedFormat,
    request: Object.freeze({ ...captured.value.request, intent }),
    baseSource: document.source ? Object.freeze({ ref: Object.freeze({ ...document.source.ref }), revision: document.source.metadata.diskRevision }) : null,
  }) };
}

export function captureRecovery(document: ManagedDocument | undefined,
  reason: WriteRecoverySnapshotRequest['reason'] = 'periodic'): ResultEnvelope<WriteRecoverySnapshotRequest> {
  if (!document) return failure('NOT_FOUND', '文档已关闭。');
  if (document.fragment) return failure('READ_ONLY', document.summary.readOnlyReason ?? '片段不能写入完整恢复快照。');
  if (!Number.isSafeInteger(document.summary.version) || document.summary.version >= Number.MAX_SAFE_INTEGER) {
    return failure('INVALID_INPUT', '文档版本无法安全写入恢复快照，请另存为。');
  }
  const captured = snapshot(document);
  if (!captured.ok) return captured;
  const { request } = captured.value;
  return { ok: true, value: Object.freeze({
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    reason,
    ...(document.source ? { baseDiskRevision: document.source.metadata.diskRevision } : {}),
    text: request.text,
    format: request.format,
    ...(request.newlineMap ? { newlineMap: request.newlineMap } : {}),
  }) };
}

export function acknowledgeExisting(document: ManagedDocument | undefined, captured: CapturedSave, ack: SaveAck): ResultEnvelope<{ dirty: boolean }> {
  if (!document) return failure('NOT_FOUND', '文档已关闭。');
  const { request, savedText } = captured;
  if (!document.source || document.source.metadata.diskRevision !== request.expectedDiskRevision
    || ack.documentVersion !== request.documentVersion || ack.documentVersion < document.savedVersion
    || ack.documentVersion > document.summary.version) return failure('CONFLICT', '保存回执与当前文档版本不匹配。');
  document.savedText = savedText;
  document.savedVersion = ack.documentVersion;
  document.savedFormat = captured.savedFormat;
  document.source = { ...document.source,
    format: { ...request.format },
    metadata: { ...document.source.metadata, diskRevision: ack.diskRevision, modifiedAt: ack.savedAt, sizeBytes: ack.sizeBytes },
  };
  document.summary = { ...document.summary, dirty: !document.state.doc.eq(savedText)
    || !sameDocumentFormat(document.state.field(documentFormat), document.savedFormat),
    recoveryProtected: false, recoveryError: null };
  return { ok: true, value: { dirty: document.summary.dirty } };
}

export function acknowledgeDestination(document: ManagedDocument | undefined, captured: CapturedSaveAs, result: SaveAsAck): ResultEnvelope<{ dirty: boolean }> {
  if (!document) return failure('NOT_FOUND', '文档已关闭。');
  const { request, baseSource, savedText } = captured;
  const current = document.source;
  if (request.intent === 'copy') return failure('INVALID_INPUT', '保存副本不能更新源文档的已保存基线。');
  if (result.documentId !== request.documentId || result.ack.documentVersion !== request.documentVersion
    || result.ack.documentVersion < document.savedVersion || result.ack.documentVersion > document.summary.version
    || result.metadata.diskRevision !== result.ack.diskRevision
    || result.metadata.sizeBytes !== result.ack.sizeBytes
    || (current?.metadata.diskRevision ?? null) !== (baseSource?.revision ?? null)
    || (current?.ref.grantId ?? null) !== (baseSource?.ref.grantId ?? null)
    || (current?.ref.relativePath ?? null) !== (baseSource?.ref.relativePath ?? null)) {
    return failure('CONFLICT', '另存回执与当前文档绑定或版本不匹配，内容仍保留。');
  }
  const reason = readOnlyReason(result.metadata, document.summary.format);
  document.state = reconfigureReadOnly(document.state, reason !== null);
  document.savedText = savedText;
  document.savedVersion = result.ack.documentVersion;
  document.savedFormat = captured.savedFormat;
  document.releaseUncertain = false;
  document.source = { documentId: request.documentId, ref: result.ref, metadata: result.metadata,
    format: { ...request.format }, warnings: current?.warnings ?? [], mode: current?.mode ?? 'normal' };
  document.summary = { ...document.summary, title: result.metadata.displayPath.split(/[\\/]/).pop() || result.metadata.displayPath,
    displayPath: result.metadata.displayPath, readOnlyReason: reason, canSaveAs: true, missing: false,
    recoveryProtected: false, recoveryError: null, recovered: false, dirty: !document.state.doc.eq(savedText)
      || !sameDocumentFormat(document.state.field(documentFormat), document.savedFormat) };
  return { ok: true, value: { dirty: document.summary.dirty } };
}

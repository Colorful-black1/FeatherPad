import type { FileRef } from '../shared/contracts/files';
import { isFileRef } from './files';
import { callCommand, isRecord } from './invoke';

export type ReplaceFileState =
  | 'ready'
  | 'dirtySkipped'
  | 'readOnly'
  | 'conflict'
  | 'unsupported'
  | 'committed'
  | 'rolledBack'
  | 'rollbackConflict';

export interface CreateReplacePlanRequest {
  requestId: string;
  roots: FileRef[];
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
  includeHidden: boolean;
  dirtyPaths: string[];
}

export interface ReplacePlanFile {
  id: string;
  ref: FileRef;
  displayName: string;
  displayPath: string;
  state: ReplaceFileState;
  reason: string | null;
  beforeRevision: string;
  afterRevision: string | null;
  beforeHash: string;
  afterHash: string;
  encoding: string;
  matches: number;
  previewBefore: string;
  previewAfter: string;
  beforeSnapshotRef: string | null;
  afterSnapshotRef: string | null;
}

export interface ReplacementPlan {
  schemaVersion: 1;
  planId: string;
  confirmationToken: string;
  createdAt: number;
  expiresAt: number;
  replacement: string;
  files: ReplacePlanFile[];
  totalMatches: number;
  truncated: boolean;
  skipped: string[];
}

export interface CommitReplacePlanRequest {
  planId: string;
  confirmationToken: string;
  selected: FileRef[];
}

export interface ReplaceBatchOutcome {
  batchId: string;
  status: 'completed' | 'partial' | 'failed';
  succeeded: string[];
  failed: string[];
  remaining: string[];
  rollbackJournalRef: string;
}

export interface RollbackReplaceBatchRequest {
  batchId: string;
}

export interface RollbackBatchOutcome {
  batchId: string;
  status: 'completed' | 'partial' | 'failed';
  restored: string[];
  conflicts: string[];
  failed: string[];
  rollbackJournalRef: string;
}

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const count = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{64}$/.test(value);
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length <= maximum;
const pathList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000
  && value.every(item => boundedText(item, 32_767));
const fileStates: readonly ReplaceFileState[] = [
  'ready', 'dirtySkipped', 'readOnly', 'conflict', 'unsupported', 'committed', 'rolledBack', 'rollbackConflict',
];

function isPlanFile(value: unknown): value is ReplacePlanFile {
  if (!isRecord(value) || !uuid(value.id) || !isFileRef(value.ref)
    || !boundedText(value.displayName, 32_767) || value.displayName.length === 0
    || !boundedText(value.displayPath, 32_767) || value.displayPath.length === 0
    || !fileStates.includes(value.state as ReplaceFileState)
    || !(value.reason === null || boundedText(value.reason, 4_096))
    || !revision(value.beforeRevision)
    || !(value.afterRevision === null || revision(value.afterRevision))
    || !revision(value.beforeHash) || !revision(value.afterHash)
    || !boundedText(value.encoding, 32) || value.encoding.length === 0
    || !count(value.matches) || value.matches > 1_000
    || !boundedText(value.previewBefore, 2_000) || !boundedText(value.previewAfter, 2_000)) return false;
  const beforeSnapshot = value.beforeSnapshotRef;
  const afterSnapshot = value.afterSnapshotRef;
  if (beforeSnapshot !== null && !(boundedText(beforeSnapshot, 128) && beforeSnapshot.length > 0)) return false;
  if (afterSnapshot !== null && !(boundedText(afterSnapshot, 128) && afterSnapshot.length > 0)) return false;
  return value.state === 'ready'
    ? beforeSnapshot !== null && afterSnapshot !== null
    : beforeSnapshot === null && afterSnapshot === null;
}

export function isReplacementPlan(value: unknown): value is ReplacementPlan {
  if (!isRecord(value) || value.schemaVersion !== 1 || !uuid(value.planId) || !uuid(value.confirmationToken)
    || !count(value.createdAt) || !count(value.expiresAt) || value.expiresAt <= value.createdAt
    || !boundedText(value.replacement, 64 * 1_024)
    || !Array.isArray(value.files) || value.files.length > 10_000 || !value.files.every(isPlanFile)
    || !count(value.totalMatches) || value.totalMatches > 10_000
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.skipped) || value.skipped.length > 10_064
    || !value.skipped.every(item => boundedText(item, 32_767))) return false;
  const ids = new Set<string>();
  const refs = new Set<string>();
  let matches = 0;
  for (const file of value.files) {
    const ref = `${file.ref.grantId}\0${file.ref.relativePath}`;
    if (ids.has(file.id) || refs.has(ref)) return false;
    ids.add(file.id);
    refs.add(ref);
    matches += file.matches;
  }
  return matches === value.totalMatches;
}

function isJournalRef(value: unknown, batchId: string): value is string {
  return value === `replacement-plans/${batchId}`;
}

function isReplaceOutcome(value: unknown): value is ReplaceBatchOutcome {
  return isRecord(value) && uuid(value.batchId)
    && ['completed', 'partial', 'failed'].includes(value.status as string)
    && pathList(value.succeeded) && pathList(value.failed) && pathList(value.remaining)
    && isJournalRef(value.rollbackJournalRef, value.batchId);
}

function isRollbackOutcome(value: unknown): value is RollbackBatchOutcome {
  return isRecord(value) && uuid(value.batchId)
    && ['completed', 'partial', 'failed'].includes(value.status as string)
    && pathList(value.restored) && pathList(value.conflicts) && pathList(value.failed)
    && isJournalRef(value.rollbackJournalRef, value.batchId);
}

export const replacementBridge = {
  preview: (request: CreateReplacePlanRequest) =>
    callCommand('create_replace_plan', { ...request }, isReplacementPlan),
  commit: (request: CommitReplacePlanRequest) =>
    callCommand('commit_replace_plan', { ...request }, (value): value is ReplaceBatchOutcome =>
      isReplaceOutcome(value) && value.batchId === request.planId),
  rollback: (request: RollbackReplaceBatchRequest) =>
    callCommand('rollback_replace_batch', { ...request }, (value): value is RollbackBatchOutcome =>
      isRollbackOutcome(value) && value.batchId === request.batchId),
};

import type { AppError, FileRef, OpenMode } from '../../shared/contracts/files';

export interface ReadOnlyOpenCandidate {
  ref: FileRef;
  mode: Exclude<OpenMode, 'normal'>;
}

export function offerReadOnlyOpen(candidates: readonly ReadOnlyOpenCandidate[], ref: FileRef, error: AppError) {
  const mode = error.code === 'TOO_LARGE' ? 'head-preview'
    : ['IS_BINARY', 'ENCODING_REQUIRED', 'LOSSY_ENCODING'].includes(error.code) ? 'text-preview' : null;
  if (!mode) return [...candidates];
  return [...candidates.filter(candidate => candidate.ref.grantId !== ref.grantId
    || candidate.ref.relativePath !== ref.relativePath), { ref, mode } satisfies ReadOnlyOpenCandidate];
}

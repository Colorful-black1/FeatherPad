import type { Text } from '@codemirror/state';
import { encodings } from '../../bridge/encoding';
import type { EncodingId, EncodingInspection } from '../../shared/contracts/encoding';
import type { DocumentId, ResultEnvelope, TextFormat } from '../../shared/contracts/files';
import { documents, type BufferChange, type DocumentRegistry } from './documents';
import { saves, type SaveCoordinator } from './save';
import { recoveries, type RecoveryCoordinator } from './recovery';

export interface FormatPlan {
  readonly id: DocumentId;
  readonly version: number;
  readonly original: Text;
  readonly format: TextFormat;
  readonly inspection: EncodingInspection;
}
const conflict = (message = '文档已变化，请重新检查后再确认转换。'): ResultEnvelope<never> => ({ ok: false,
  error: { code: 'CONFLICT', message, retryable: false } });

export function replacementChanges(original: string, candidate: string, expectedCount: number): BufferChange[] | null {
  const changes: BufferChange[] = [];
  let from = 0; let output = 0;
  for (const character of original) {
    if (candidate.startsWith(character, output)) output += character.length;
    else if (character !== '\n' && candidate[output] === '?') {
      changes.push({ from, to: from + character.length, insert: '?' }); output++;
    } else return null;
    from += character.length;
  }
  return output === candidate.length && changes.length === expectedCount ? changes : null;
}

export class FormatCoordinator {
  constructor(private readonly registry: DocumentRegistry, private readonly transport = encodings,
    private readonly saving: Pick<SaveCoordinator, 'exclusive'> = saves,
    private readonly recovery: Pick<RecoveryCoordinator, 'flush'> = recoveries) {}

  async plan(id: DocumentId, format: TextFormat): Promise<ResultEnvelope<FormatPlan>> {
    const document = this.registry.getDocument(id);
    if (!document || document.fragment || document.summary.readOnlyReason) return conflict('当前文档不能转换。');
    const version = document.summary.version;
    const original = document.state.doc;
    const inspection = await this.transport.check(original.toString(), format.encoding as EncodingId, version);
    if (!inspection.ok) return inspection;
    if (this.registry.getDocument(id)?.summary.version !== version || this.registry.getDocument(id)?.state.doc !== original) return conflict();
    return { ok: true, value: { id, version, original, format: { ...format }, inspection: inspection.value } };
  }

  apply(plan: FormatPlan, acceptLoss = false): ResultEnvelope<{ version: number }> {
    const document = this.registry.getDocument(plan.id);
    if (!document || document.summary.version !== plan.version || document.state.doc !== plan.original) return conflict();
    if (plan.inspection.lossCount > 0 && !acceptLoss) return { ok: false,
      error: { code: 'CANCELLED', message: '已取消有损转换，原正文保留。', retryable: false } };
    const changes = plan.inspection.lossCount > 0
      ? replacementChanges(plan.original.toString(), plan.inspection.replacementText ?? '', plan.inspection.lossCount) : [];
    if (!changes) return conflict('编码替代候选与原文不匹配，正文未修改。');
    return this.registry.changeFormat(plan.id, plan.version, plan.format, changes);
  }

  async reopen(id: DocumentId, version: number, encoding: EncodingId, choice: 'save' | 'discard' | 'clean'):
    Promise<ResultEnvelope<{ reloaded: true }>> {
    if (this.registry.getDocument(id)?.summary.version !== version) return conflict();
    if (choice === 'discard') {
      const protectedDraft = await this.recovery.flush(id, 'hot-exit');
      if (!protectedDraft.ok) return protectedDraft;
    }
    return this.saving.exclusive(id, async save => {
      let document = this.registry.getDocument(id);
      if (!document?.source || document.source.mode === 'text-preview' || document.summary.version !== version) return conflict();
      if (document.summary.dirty && choice === 'save') {
        const saved = await save();
        if (!saved.ok) return saved;
        document = this.registry.getDocument(id);
      }
      if (!document?.source || document.summary.version !== version
        || (document.summary.dirty && (choice !== 'discard' || !document.summary.recoveryProtected))) return conflict();
      const base = document.source.metadata.diskRevision;
      const originalEncoding = document.source.format.encoding as EncodingId;
      const restoreInterpretation = async () => {
        const restored = await this.transport.reopen(id, originalEncoding, base);
        if (!restored.ok) this.registry.retainUncertainRelease(id,
          '编码重开结果尚未确认；完整正文已保留，请另存为后重新打开原文件。');
      };
      const loaded = await this.transport.reopen(id, encoding, base);
      if (!loaded.ok) {
        if (loaded.error.code === 'IPC_UNAVAILABLE') {
          // This operation only changes an interpretation/lease. Reconcile an unknown
          // result by explicitly restoring the prior interpretation; never guess success.
          await restoreInterpretation();
        }
        return loaded;
      }
      const applied = this.registry.applyDiskReload(loaded.value, version, base, choice === 'discard');
      if (!applied.ok) await restoreInterpretation();
      return applied;
    });
  }
}

export const formats = new FormatCoordinator(documents);

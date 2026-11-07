import { files } from '../../bridge/files';
import { workspaceFiles } from '../../bridge/workspace';
import type { RenamedDocument, ResultEnvelope } from '../../shared/contracts/files';
import type { WorkspaceRoot, WorkspaceStore } from './store';

export class WorkspaceRoots {
  constructor(private readonly store: WorkspaceStore,
    private readonly remap: (documents: readonly RenamedDocument[]) => void | Promise<void>,
    private readonly transport: Pick<typeof workspaceFiles, 'inspectRoot' | 'releaseRoot'> = workspaceFiles,
    private readonly choose = files.chooseFolder) {}

  async chooseRoot(add = false, startIn?: string): Promise<ResultEnvelope<WorkspaceRoot | null>> {
    const selected = await this.choose(startIn);
    if (!selected.ok) return selected;
    if (!selected.value.grant || !selected.value.displayName) return { ok: true, value: null };
    return this.openRoot({ grant: selected.value.grant, displayName: selected.value.displayName }, add);
  }

  async openRoot(candidate: WorkspaceRoot, add = false): Promise<ResultEnvelope<WorkspaceRoot>> {
    if (add && this.store.getSnapshot().roots.length >= 16
      && !this.store.getSnapshot().roots.some(root => root.grant.grantId === candidate.grant.grantId)) {
      return { ok: false, error: { code: 'TOO_LARGE', message: '工作区最多16个根，请先移除一个根。', retryable: false } };
    }
    const inspected = await this.transport.inspectRoot(candidate.grant);
    if (!inspected.ok) return inspected;
    const root: WorkspaceRoot = { ...candidate, displayName: inspected.value.displayName,
      displayPath: inspected.value.displayPath, canonicalIdentity: inspected.value.canonicalIdentity };
    if (add) this.store.addRoot(root);
    else {
      for (const previous of this.store.getSnapshot().roots) {
        if (previous.grant.grantId === root.grant.grantId) continue;
        const removed = await this.removeRoot(previous);
        if (!removed.ok) return removed;
      }
      this.store.setRoot(root);
    }
    return { ok: true, value: root };
  }

  async removeRoot(root: WorkspaceRoot): Promise<ResultEnvelope<{ removed: true }>> {
    const result = await this.transport.releaseRoot(root.grant);
    if (!result.ok) return result;
    await this.remap(result.value.renamedDocuments);
    this.store.removeRoot(root.grant.grantId);
    return { ok: true, value: { removed: true } };
  }
}

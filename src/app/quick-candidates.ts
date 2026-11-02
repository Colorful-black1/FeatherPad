import type { DocumentId, FileRef } from '../shared/contracts/files';
import type { PaletteItem } from '../shared/ui/CommandPalette';
import type { WorkspaceSnapshot } from '../features/workspace/store';

interface QuickDocument { id: DocumentId; title: string; displayPath: string | null; ref: FileRef | null }
export type QuickTarget = { kind: 'document'; id: DocumentId } | { kind: 'file'; ref: FileRef };
const candidateLimit = 5_000;
const refKey = (ref: FileRef) => JSON.stringify([ref.grantId, ref.relativePath]);

export function quickCandidates(documents: readonly QuickDocument[], workspace: WorkspaceSnapshot) {
  const items: PaletteItem[] = [];
  const targets = new Map<string, QuickTarget>();
  const seen = new Set<string>();
  let truncated = false;
  for (const document of documents) {
    if (items.length >= candidateLimit) { truncated = true; break; }
    const id = `document:${document.id}`;
    items.push({ id, title: document.title, detail: document.displayPath ?? '未命名文档', keywords: '已打开', binding: null, disabledReason: null });
    targets.set(id, { kind: 'document', id: document.id });
    if (document.ref) seen.add(refKey(document.ref));
  }
  if (workspace.root) {
    outer: for (const record of Object.values(workspace.records)) {
      for (const entry of record.items) {
        if (entry.kind !== 'file' || (!workspace.showHidden && entry.isHidden) || entry.ref.grantId !== workspace.root.grant.grantId) continue;
        const key = refKey(entry.ref);
        if (seen.has(key)) continue;
        if (items.length >= candidateLimit) { truncated = true; break outer; }
        seen.add(key);
        const id = `file:${key}`;
        items.push({ id, title: entry.name, detail: `${workspace.root.displayName}/${entry.ref.relativePath}`,
          keywords: '目录文件', binding: null, disabledReason: null });
        targets.set(id, { kind: 'file', ref: entry.ref });
      }
    }
  }
  return { items, targets, scope: `仅列出已打开文档和目录树已加载的文件；展开文件夹可加入候选。${truncated ? '已达到5,000项候选上限。' : ''}` };
}

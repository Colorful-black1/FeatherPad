import { useCallback, useState } from 'react';
import { files } from '../bridge/files';
import { workspaceFiles } from '../bridge/workspace';
import { session } from '../features/desktop/session';
import { workspace, type WorkspaceRoot } from '../features/workspace/store';
import type { WorkspaceRoots } from '../features/workspace/roots';
import {
  workspaceConfigFromRoots,
  type WorkspaceFileConfig,
  type WorkspaceFileDocument,
} from '../features/workspace/workspace-file';

export function useWorkspaceFile(
  rootsCoordinator: WorkspaceRoots,
  report: (message: string | null) => void,
) {
  const [document, setDocument] = useState<WorkspaceFileDocument | null>(null);

  const open = useCallback(async (): Promise<string | null> => {
    const loaded = await workspaceFiles.openFile();
    if (!loaded.ok) return loaded.error.message;
    if (!loaded.value) return null;
    const selected: WorkspaceRoot[] = [];
    for (let index = 0; index < loaded.value.config.roots.length; index++) {
      const configuration = loaded.value.config.roots[index]!;
      const choice = await files.chooseFolder();
      if (!choice.ok) return choice.error.message;
      if (!choice.value.grant || !choice.value.displayName) {
        return `工作区文件保留了 ${loaded.value.config.roots.length - selected.length} 个未授权根；本次没有替换当前工作区。`;
      }
      const inspected = await workspaceFiles.inspectRoot(choice.value.grant);
      if (!inspected.ok) return inspected.error.message;
      selected.push({
        grant: choice.value.grant,
        displayName: configuration.name || inspected.value.displayName,
        displayPath: inspected.value.displayPath,
        canonicalIdentity: inspected.value.canonicalIdentity,
      });
    }

    const previous = workspace.getSnapshot().roots;
    for (const root of previous) {
      if (selected.some(next => next.canonicalIdentity === root.canonicalIdentity)) continue;
      const removed = await rootsCoordinator.removeRoot(root);
      if (!removed.ok) return `旧工作区根未能安全移除：${removed.error.message}`;
    }
    if (!workspace.replaceRoots(selected)) return '工作区文件包含过多根，当前工作区未替换。';
    for (const root of selected) session.markGrantAvailable(root.grant.grantId);
    const flushed = await session.flush();
    if (!flushed.ok) return `工作区已恢复，但授权会话未落盘：${flushed.error.message}`;
    setDocument(loaded.value);
    report(`已恢复工作区文件“${loaded.value.displayName}”及其 ${selected.length} 个根。`);
    return null;
  }, [report, rootsCoordinator]);

  const save = useCallback(async (): Promise<string | null> => {
    const current = workspace.getSnapshot().roots;
    if (current.length === 0) return '当前没有可保存的工作区根。';
    let config: WorkspaceFileConfig;
    try {
      config = document
        ? { ...document.config, roots: workspaceConfigFromRoots(current, document.config.workspaceId,
          document.config).roots }
        : workspaceConfigFromRoots(current);
    } catch (error) {
      return error instanceof Error ? error.message : '工作区配置格式无效。';
    }
    const saved = document ? await workspaceFiles.saveFile(document, config) : await workspaceFiles.saveFileAs(config);
    if (!saved.ok) return saved.error.message;
    if (!saved.value) return null;
    setDocument(saved.value);
    report(`工作区文件已保存：${saved.value.displayPath}`);
    return null;
  }, [document, report]);

  return { document, open, save };
}

import { useCallback, useState, type RefObject } from 'react';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import { previewBridge } from '../../bridge/preview';
import type { DocumentRegistry } from '../editor/documents';
import type { RenderReply } from './parser';
import { safePreviewUrl } from './links';

export function usePreviewLinks({ registry, id, directory, reply, frame, channel, onNotice, onOpenFile }: {
  registry: DocumentRegistry; id: DocumentId; directory: FileRef | null;
  reply: Extract<RenderReply, { ok: true }> | undefined; frame: RefObject<HTMLIFrameElement | null>; channel: string;
  onNotice: (message: string) => void; onOpenFile: ((reference: FileRef) => void) | undefined;
}) {
  const [pending, setPending] = useState<{ url: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const openUrl = useCallback((value: string) => {
    if (!reply || registry.getDocument(id)?.summary.version !== reply.bufferVersion) return;
    const url = safePreviewUrl(value, 'link');
    if (url.kind === 'blocked') onNotice(url.reason);
    else if (url.kind === 'external') setPending({ url: url.url, version: reply.bufferVersion });
    else if (url.kind === 'anchor') frame.current?.contentWindow?.postMessage({ channel, kind: 'anchor', fragment: url.fragment }, '*');
    else if (url.kind === 'local') {
      const source = registry.getDocument(id)?.source;
      void previewBridge.link({ documentId: source ? id : null, directory, url: url.url }).then(result => {
        if (registry.getDocument(id)?.summary.version !== reply.bufferVersion) return;
        if (!result.ok) onNotice(result.error.message);
        else if (onOpenFile) onOpenFile(result.value);
        else onNotice('当前视图无法打开链接文件。');
      });
    } else onNotice('数据图片不能作为文档链接打开。');
  }, [registry, id, reply, directory, frame, channel, onNotice, onOpenFile]);
  const openIndex = useCallback((index: number) => {
    const link = reply?.links[index];
    if (link) openUrl(link.url);
  }, [reply, openUrl]);
  const close = () => { if (!busy) setPending(null); };
  const confirm = async () => {
    if (!pending || busy) return;
    if (registry.getDocument(id)?.summary.version !== pending.version) {
      onNotice('文档已变化，请重新核对链接目标。'); setPending(null); return;
    }
    setBusy(true);
    const result = await previewBridge.openExternal(pending.url);
    onNotice(result.ok ? '已交给系统打开链接。' : result.error.message);
    setBusy(false); setPending(null);
  };
  return { pending, busy, close, confirm, openIndex, openUrl };
}

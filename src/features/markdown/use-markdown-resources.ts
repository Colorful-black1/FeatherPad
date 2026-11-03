import { useEffect, useState } from 'react';
import type { DocumentId, FileRef } from '../../shared/contracts/files';
import { previewBridge } from '../../bridge/preview';
import type { DocumentRegistry } from '../editor/documents';
import { safePreviewUrl } from './links';
import type { RenderReply } from './parser';
import { safeImageData } from './sanitize';

export interface PreviewImage { dataUrl: string; width: number; height: number }
interface ResourceState {
  requestId: string;
  images: ReadonlyMap<number, PreviewImage>;
  failures: { index: number; reason: string }[];
  busy: boolean;
}
const emptyImages: ReadonlyMap<number, PreviewImage> = new Map();

export function useMarkdownResources(registry: DocumentRegistry, id: DocumentId,
  reply: Extract<RenderReply, { ok: true }> | undefined, directory: FileRef | null) {
  const [state, setState] = useState<ResourceState | null>(null);
  useEffect(() => {
    if (!reply || reply.images.length === 0) return;
    let disposed = false;
    const current = () => !disposed && registry.getDocument(id)?.summary.version === reply.bufferVersion;
    const delay = setTimeout(() => {
      void (async () => {
        const images = new Map<number, PreviewImage>();
        const failures: ResourceState['failures'] = [];
        const publish = (busy: boolean) => { if (current()) setState({ requestId: reply.requestId, images: new Map(images), failures: [...failures], busy }); };
        publish(true);
        let remaining = 50 * 1024 * 1024;
        for (const [index, image] of reply.images.entries()) {
          if (!current()) return;
          const url = safePreviewUrl(image.url, 'image');
          if (index >= 256 || remaining <= 0) { failures.push({ index, reason: '图片数量或总嵌入预算已用完。' }); continue; }
          if (url.kind !== 'local' && url.kind !== 'data-image') {
            failures.push({ index, reason: url.kind === 'blocked' ? url.reason : '远程图片默认阻止，可显式在浏览器中查看原链接。' });
            continue;
          }
          const source = registry.getDocument(id)?.source;
          if (url.kind === 'local' && !source && !directory) {
            failures.push({ index, reason: '无标题文档尚无资源基目录，请显式选择目录。' });
            continue;
          }
          const result = await previewBridge.read({ documentId: source ? id : null, directory, url: url.url,
            maxBytes: Math.min(20 * 1024 * 1024, remaining) });
          if (!current()) return;
          if (!result.ok) { failures.push({ index, reason: result.error.message }); continue; }
          try {
            const safe = safeImageData(result.value);
            remaining -= result.value.sizeBytes;
            images.set(index, safe);
          } catch {
            failures.push({ index, reason: '图片清洗或尺寸验证失败，已保留占位。' });
          }
        }
        publish(false);
      })();
    }, 0);
    return () => { disposed = true; clearTimeout(delay); };
  }, [registry, id, reply, directory]);
  return state && state.requestId === reply?.requestId ? state
    : { images: emptyImages, failures: [], busy: Boolean(reply?.images.length) };
}

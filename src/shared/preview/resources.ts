import { previewBridge, type ResourceRequest } from '../../bridge/preview';
import { safeImageData } from './image-data';
import { safePreviewUrl } from './urls';

export interface PreviewImage { dataUrl: string; width: number; height: number }
export interface PreviewResourceResult { images: ReadonlyMap<number, PreviewImage>; failures: { index: number; reason: string }[] }

export async function resolvePreviewImages(labels: readonly { url: string; alt: string }[],
  scope: Pick<ResourceRequest, 'documentId' | 'directory'>, signal: AbortSignal): Promise<PreviewResourceResult> {
  const images = new Map<number, PreviewImage>(), failures: PreviewResourceResult['failures'] = [];
  let remaining = 50 * 1024 * 1024;
  for (const [index, image] of labels.entries()) {
    signal.throwIfAborted();
    const url = safePreviewUrl(image.url, 'image');
    let reason = '';
    if (index >= 256 || remaining <= 0) reason = '图片数量或50MiB总嵌入预算已用完。';
    else if (url.kind !== 'local' && url.kind !== 'data-image') reason = url.kind === 'blocked' ? url.reason : '远程图片默认阻止，可显式在浏览器中查看原链接。';
    else if (url.kind === 'local' && !scope.documentId && !scope.directory) reason = '无标题文档尚无资源基目录，请显式选择目录。';
    else {
      const result = await previewBridge.read({ ...scope, url: url.url, maxBytes: Math.min(20 * 1024 * 1024, remaining) });
      signal.throwIfAborted();
      if (!result.ok) reason = result.error.message;
      else try { images.set(index, safeImageData(result.value)); remaining -= result.value.sizeBytes; }
      catch { reason = '图片清洗或尺寸验证失败，已保留占位。'; }
    }
    if (reason) failures.push({ index, reason });
  }
  return { images, failures };
}

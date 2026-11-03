import { useEffect, useMemo, useRef, useState } from 'react';
import { encodings } from '../../bridge/encoding';
import { externalFiles } from '../../bridge/external';
import { files } from '../../bridge/files';
import type { DocumentId, DiskRevision } from '../../shared/contracts/files';
import { safeImageData } from '../../shared/preview/image-data';
import type { DocumentRegistry } from './documents';

export function ImageView({ registry, id, group, autoFocus }: {
  registry: DocumentRegistry; id: DocumentId; group: 'primary' | 'secondary'; autoFocus: boolean;
}) {
  const record = registry.getDocument(id)!;
  const image = record.fragment?.kind === 'image' ? record.fragment.image : null;
  const safe = useMemo(() => {
    if (!image) return { ok: false as const, message: '图片已关闭。' };
    try { return { ok: true as const, ...safeImageData(image) }; }
    catch { return { ok: false as const, message: '图片清洗或尺寸验证失败，已停止显示。' }; }
  }, [image]);
  const root = useRef<HTMLElement>(null), viewport = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null), frozen = useRef<HTMLCanvasElement>(null);
  const [bounds, setBounds] = useState({ width: 800, height: 600 });
  const [mode, setMode] = useState<'fit' | 'zoom'>('fit'); const [zoom, setZoom] = useState(100);
  const [decoded, setDecoded] = useState<{ image: typeof image; width: number; height: number } | null>(null);
  const [failure, setFailure] = useState<{ image: typeof image; message: string } | null>(null);
  const [pauseSource, setPauseSource] = useState<typeof image>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const paused = pauseSource === image && image !== null;
  const width = decoded?.image === image ? decoded.width : safe.ok ? safe.width : 1;
  const height = decoded?.image === image ? decoded.height : safe.ok ? safe.height : 1;
  const scale = mode === 'fit' ? Math.max(.1, Math.min(8, (bounds.width - 32) / width, (bounds.height - 32) / height)) : zoom / 100;
  const error = !safe.ok ? safe.message : failure?.image === image ? failure.message : null;
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect; if (box) setBounds({ width: box.width, height: box.height });
    });
    if (viewport.current) observer.observe(viewport.current);
    if (autoFocus) root.current?.focus();
    return () => observer.disconnect();
  }, [autoFocus]);
  function changeZoom(value: number) { setMode('zoom'); setZoom(Math.max(10, Math.min(800, value))); }
  function pause() {
    if (paused) { setPauseSource(null); if (frozen.current) { frozen.current.width = 0; frozen.current.height = 0; } return; }
    const canvas = frozen.current, img = picture.current;
    if (!canvas || !img || !img.complete || img.naturalWidth * img.naturalHeight > 40_000_000) return;
    try {
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d'); if (!context) throw new Error('No canvas');
      context.drawImage(img, 0, 0); setPauseSource(image);
    } catch { setMessage('无法暂停此图片，原图仍保留。'); }
  }
  async function reopen(asText = false) {
    if (busy || !record.source) return;
    const version = record.summary.version, revision = record.source.metadata.diskRevision;
    setBusy(true); setMessage(null);
    try {
      const result = asText ? image?.mime === 'image/svg+xml'
        ? await encodings.reopen(id, 'utf-8', revision)
        : await files.open(record.source.ref, 'text-preview')
        : await (async () => {
          const metadata = await files.stat(id);
          return metadata.ok ? externalFiles.reload(id, metadata.value.diskRevision as DiskRevision) : metadata;
        })();
      if (!result.ok) { setMessage(result.error.message); return; }
      if (!('documentId' in result.value)) return;
      const applied = registry.applyDiskReload(result.value, version, revision);
      if (!applied.ok) setMessage(applied.error.message);
    } finally { setBusy(false); }
  }
  return <section ref={root} className="image-view" role="tabpanel" id={`panel-${group}-${id}`} tabIndex={-1}
    aria-label={`${group === 'primary' ? '主编辑组' : '第二编辑组'}图片：${record.summary.title}`}>
    <header className="document-heading"><span>{record.summary.displayPath}</span><strong>▧ 图片 · 只读</strong></header>
    <div className="image-toolbar" role="group" aria-label="图片查看控制">
      <button type="button" className="plain-button" aria-pressed={mode === 'fit'} onClick={() => setMode('fit')}>适应窗口</button>
      <button type="button" className="plain-button" onClick={() => changeZoom(100)}>原尺寸</button>
      <button type="button" className="plain-button" aria-label="缩小图片" disabled={scale <= .1} onClick={() => changeZoom(Math.round(scale * 100) - 10)}>−</button>
      <label>缩放 <input type="number" aria-label="图片缩放百分比" min={10} max={800} value={Math.round(scale * 100)} onChange={event => {
        const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) changeZoom(value);
      }} />%</label>
      <button type="button" className="plain-button" aria-label="放大图片" disabled={scale >= 8} onClick={() => changeZoom(Math.round(scale * 100) + 10)}>+</button>
      <span aria-label="图片尺寸与大小">{Math.round(width)} × {Math.round(height)} · {(image?.sizeBytes ?? 0).toLocaleString('zh-CN')} bytes</span>
      {image?.mime === 'image/gif' && <button type="button" className="plain-button" aria-pressed={paused} onClick={pause}>{paused ? '恢复GIF动画' : '暂停GIF动画'}</button>}
      <button type="button" className="plain-button" disabled={busy || record.summary.closing || record.summary.hotExitFrozen} onClick={() => void reopen()}>重新读取图片</button>
      <button type="button" className="plain-button" disabled={busy || record.summary.closing || record.summary.hotExitFrozen} onClick={() => void reopen(true)}>{image?.mime === 'image/svg+xml' ? '作为文本打开（UTF-8）' : '只读文本试开'}</button>
    </div>
    {(message || error) && <p className="notice" role="alert">{message ?? error}</p>}
    <div className="image-viewport" ref={viewport} tabIndex={0} aria-label="只读图片画布">
      {safe.ok && !error && <div className="image-stage" style={{ width: width * scale, height: height * scale }}>
        <img ref={picture} src={safe.dataUrl} alt={record.summary.title} hidden={paused}
          style={{ width: width * scale, height: height * scale }} onError={() => setFailure({ image, message: '图片解码失败，请重新打开或选择其他文件。' })}
          onLoad={event => {
            const img = event.currentTarget;
            if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40_000_000) setFailure({ image, message: '实际解码尺寸超过40MP或无效，已停止显示。' });
            else setDecoded({ image, width: img.naturalWidth, height: img.naturalHeight });
          }} />
        <canvas ref={frozen} hidden={!paused} aria-label="GIF暂停帧" style={{ width: width * scale, height: height * scale }} />
      </div>}
    </div>
  </section>;
}

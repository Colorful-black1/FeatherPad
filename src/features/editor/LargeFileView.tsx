import { useRef, useState } from 'react';
import { files } from '../../bridge/files';
import type { DocumentId, TextChunk } from '../../shared/contracts/files';
import type { ManagedDocument } from './documents';

interface LargeFileViewProps {
  document: Readonly<ManagedDocument>;
}

const chunkSize = 64 * 1024;
const number = new Intl.NumberFormat('zh-CN');

interface ChunkPage {
  chunk: TextChunk;
  previousStarts: number[];
}

export function LargeFileView({ document }: LargeFileViewProps) {
  const fragment = document.fragment;
  const initialChunk = fragment?.kind === 'chunked' ? fragment.initialChunk : null;
  const [page, setPage] = useState<ChunkPage | null>(initialChunk
    ? { chunk: initialChunk, previousStarts: [] }
    : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  async function loadPage(offset: number, previousStarts: number[]) {
    if (!page || document.source === null || document.summary.missing || fragment?.kind !== 'chunked' || loading) return;
    const requestId = ++request.current;
    setLoading(true);
    setError(null);
    const result = await files.readChunk({
      documentId: document.summary.id as DocumentId,
      handleId: fragment.handleId,
      expectedDiskRevision: document.source.metadata.diskRevision,
      byteOffset: offset,
      maxBytes: chunkSize,
    });
    if (requestId !== request.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.value.byteStart !== offset) {
      setError('读取块未从请求位置开始，已停止分页；请重新打开文件。');
      return;
    }
    setPage({ chunk: result.value, previousStarts });
  }

  function loadNext() {
    if (!page || !page.chunk.hasMore) return;
    void loadPage(page.chunk.byteEnd, [...page.previousStarts, page.chunk.byteStart]);
  }

  function loadPrevious() {
    const previousStart = page?.previousStarts.at(-1);
    if (page === null || previousStart === undefined) return;
    void loadPage(previousStart, page.previousStarts.slice(0, -1));
  }

  if (fragment?.kind === 'head') {
    return <section className="large-file-view" aria-label="大文件限量预览">
      <div className="large-file-toolbar">
        <strong>前 {number.format(fragment.previewBytes)} 字节</strong>
        <span>文件共 {number.format(fragment.totalBytes)} 字节 · 截断预览，只读</span>
      </div>
      <pre className="large-file-text" tabIndex={0}>{fragment.text}</pre>
    </section>;
  }

  if (!page || fragment?.kind !== 'chunked') return null;
  const { chunk } = page;
  return <section className="large-file-view" aria-label="大文件分块只读视图">
    <div className="large-file-toolbar">
      <strong>第 {number.format(page.previousStarts.length + 1)} 页 · 第 {number.format(chunk.firstLine)} 行起</strong>
      <span>{number.format(chunk.byteEnd)} / {number.format(fragment.totalBytes)} 字节 · 只读</span>
      <span className="large-file-navigation">
        <button className="plain-button" onClick={loadPrevious} disabled={document.summary.missing || page.previousStarts.length === 0 || loading}>上一块</button>
        <button className="plain-button" onClick={loadNext} disabled={document.summary.missing || !chunk.hasMore || loading}>
          {loading ? '正在读取…' : chunk.hasMore ? '下一块' : '已到文件末尾'}
        </button>
      </span>
    </div>
    {error && <p className="notice error-notice" role="alert">{error}</p>}
    <pre className="large-file-text" tabIndex={0} aria-busy={loading}>{chunk.text}</pre>
  </section>;
}

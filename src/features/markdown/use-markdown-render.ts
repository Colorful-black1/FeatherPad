import { useEffect, useRef, useState } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import { MAX_LIVE_BYTES, MAX_RENDER_BYTES, type RenderReply, type RenderRequest } from './parser';

type RenderState = { version: number; htmlEnabled: boolean; status: 'loading' | 'ready' | 'paused' | 'error';
  reply?: Extract<RenderReply, { ok: true }>; message?: string };

export function useMarkdownRender(registry: DocumentRegistry, id: DocumentId, version: number, enabled: boolean, htmlEnabled: boolean) {
  const [state, setState] = useState<RenderState | null>(null);
  const [lastReady, setLastReady] = useState<{ id: DocumentId; htmlEnabled: boolean;
    reply: Extract<RenderReply, { ok: true }> } | null>(null);
  const [manualVersion, setManualVersion] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cancelJob = useRef<(() => void) | null>(null);
  const idleWorker = useRef<Worker | null>(null);
  useEffect(() => () => {
    idleWorker.current?.terminate(); idleWorker.current = null;
  }, [id]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let worker: Worker | null = null;
    let active = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      disposed = true;
      if (active) {
        worker?.terminate();
        if (idleWorker.current === worker) idleWorker.current = null;
      }
      clearTimeout(deadline);
    };
    cancelJob.current = dispose;
    const delay = setTimeout(() => {
      const record = registry.getDocument(id);
      if (!record || record.summary.version !== version || disposed) return;
      if (record.state.doc.length >= MAX_RENDER_BYTES) {
        setState({ version, htmlEnabled, status: 'error', message: '文档过大，不提供完整阅读或导出。' });
        return;
      }
      const source = record.state.doc.toString();
      const bytes = new TextEncoder().encode(source).byteLength;
      const longLine = source.split('\n').some(line => line.length > 100_000);
      if ((bytes > MAX_LIVE_BYTES || longLine) && manualVersion !== version) {
        setState({ version, htmlEnabled, status: 'paused', message: '大文档或长行已暂停实时阅读，可手动生成一次预览。' });
        return;
      }
      setState({ version, htmlEnabled, status: 'loading' });
      const request: RenderRequest = { requestId: crypto.randomUUID(), documentId: id, bufferVersion: version, source, allowHtml: htmlEnabled };
      try {
        worker = idleWorker.current ?? new Worker(new URL('../../workers/markdown.worker.ts', import.meta.url), { type: 'module' });
        idleWorker.current = worker;
        active = true;
        deadline = setTimeout(() => {
          dispose();
          setState({ version, htmlEnabled, status: 'error', message: '阅读渲染超过2秒预算，已取消；源码仍保留。' });
        }, 2000);
        worker.onmessage = (event: MessageEvent<RenderReply>) => {
          const reply = event.data;
          if (disposed || reply.requestId !== request.requestId || reply.documentId !== id
            || reply.bufferVersion !== version || registry.getDocument(id)?.summary.version !== version) return;
          active = false;
          if (worker) { worker.onmessage = null; worker.onerror = null; }
          dispose();
          if (reply.ok) setLastReady({ id, htmlEnabled, reply });
          setState(reply.ok ? { version, htmlEnabled, status: 'ready', reply }
            : { version, htmlEnabled, status: 'error', message: reply.message });
        };
        worker.onerror = () => {
          dispose();
          setState({ version, htmlEnabled, status: 'error', message: '阅读渲染无法启动，请重试；源码仍保留。' });
        };
        worker.postMessage(request);
      } catch {
        dispose();
        setState({ version, htmlEnabled, status: 'error', message: '阅读渲染无法启动，请重试；源码仍保留。' });
      }
    }, 80);
    return () => { clearTimeout(delay); dispose(); cancelJob.current = null; };
  }, [registry, id, version, enabled, htmlEnabled, manualVersion, attempt]);
  const current = state?.version === version && state.htmlEnabled === htmlEnabled ? state
    : enabled && lastReady?.id === id && lastReady.htmlEnabled === htmlEnabled
      ? { version, htmlEnabled, status: 'loading' as const, reply: lastReady.reply } : null;
  return {
    state: current,
    retry: () => { setManualVersion(version); setAttempt(value => value + 1); },
    cancel: () => {
      cancelJob.current?.();
      setState({ version, htmlEnabled, status: 'paused', message: '已取消阅读渲染，源码仍保留。' });
    },
  };
}

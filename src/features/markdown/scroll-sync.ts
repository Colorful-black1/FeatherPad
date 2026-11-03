import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { EditorView } from '@codemirror/view';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import type { RenderReply } from './parser';
import { blockAtSource, type MarkdownHeading } from './source-map';

function editorView(root: RefObject<HTMLDivElement | null>) {
  const editor = root.current?.querySelector<HTMLElement>('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
}

export function useMarkdownScroll({ registry, id, root, frame, reply, channel, enabled, split, previewAction }: {
  registry: DocumentRegistry; id: DocumentId; root: RefObject<HTMLDivElement | null>;
  frame: RefObject<HTMLIFrameElement | null>; reply: Extract<RenderReply, { ok: true }> | undefined;
  channel: string; enabled: boolean; split: boolean; previewAction: { current: boolean };
}) {
  const ignoreSourceUntil = useRef(0);
  const lastPreview = useRef(0);
  const lastVersion = useRef(-1);
  const current = useCallback(() => reply && registry.getDocument(id)?.summary.version === reply.bufferVersion,
    [registry, id, reply]);
  const sendSourceBlock = useCallback(() => {
    const editor = editorView(root);
    if (!editor || !reply || !current()) return;
    const top = Math.max(0, editor.scrollDOM.getBoundingClientRect().top - editor.documentTop);
    const block = blockAtSource(reply.sourceMap, editor.lineBlockAtHeight(top).from);
    if (block) frame.current?.contentWindow?.postMessage({ channel, kind: 'sourceScroll', from: block.from }, '*');
  }, [root, reply, current, frame, channel]);
  useEffect(() => {
    if (!reply || !enabled || !split || reply.mappingWarning) return;
    let scroller: HTMLElement | null = null;
    let scheduled = 0;
    const scroll = () => {
      if (performance.now() < ignoreSourceUntil.current || scheduled) return;
      scheduled = requestAnimationFrame(() => { scheduled = 0; sendSourceBlock(); });
    };
    const takeControl = () => { ignoreSourceUntil.current = 0; };
    const bind = () => {
      scroller?.removeEventListener('scroll', scroll);
      for (const event of ['wheel', 'keydown', 'pointerdown', 'touchstart']) scroller?.removeEventListener(event, takeControl);
      scroller = editorView(root)?.scrollDOM ?? null;
      scroller?.addEventListener('scroll', scroll, { passive: true });
      for (const event of ['wheel', 'keydown', 'pointerdown', 'touchstart']) scroller?.addEventListener(event, takeControl, { passive: true });
    };
    bind();
    const host = root.current?.querySelector('.codemirror-host');
    const observer = new MutationObserver(bind);
    if (host) observer.observe(host, { childList: true });
    return () => {
      observer.disconnect(); cancelAnimationFrame(scheduled);
      scroller?.removeEventListener('scroll', scroll);
      for (const event of ['wheel', 'keydown', 'pointerdown', 'touchstart']) scroller?.removeEventListener(event, takeControl);
    };
  }, [reply, enabled, split, root, sendSourceBlock]);
  const previewScroll = useCallback((from: number) => {
    if (!reply || !current() || !reply.sourceMap.some(block => block.from === from)) return;
    lastPreview.current = from;
    if (!enabled || !split || reply.mappingWarning) return;
    ignoreSourceUntil.current = performance.now() + 180;
    editorView(root)?.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start' }) });
  }, [reply, current, enabled, split, root]);
  const frameReady = useCallback(() => {
    if (!reply || !current()) return;
    const changed = lastVersion.current !== reply.bufferVersion;
    lastVersion.current = reply.bufferVersion;
    if (changed && split && enabled && !previewAction.current && !reply.mappingWarning) sendSourceBlock();
    else {
      const block = blockAtSource(reply.sourceMap, lastPreview.current);
      if (block) frame.current?.contentWindow?.postMessage({ channel, kind: 'sourceScroll', from: block.from }, '*');
    }
  }, [reply, current, split, enabled, previewAction, sendSourceBlock, frame, channel]);
  const go = useCallback((heading: MarkdownHeading) => {
    if (!reply || !current() || !reply.headings.some(item => item.from === heading.from && item.anchor === heading.anchor)) return;
    ignoreSourceUntil.current = performance.now() + 180;
    registry.focusOffset(id, heading.from);
    lastPreview.current = heading.from;
    frame.current?.contentWindow?.postMessage({ channel, kind: 'anchor', fragment: heading.anchor }, '*');
  }, [registry, id, reply, current, frame, channel]);
  return { previewScroll, frameReady, go };
}

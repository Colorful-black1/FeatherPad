import { renderMarkdown, type RenderRequest } from '../features/markdown/parser';
import { highlightCodeBlock } from '../features/markdown/code-block';

// Each job owns a worker. The host terminates it on cancellation, version change
// or the 2s budget, including cases where the parser cannot yield cooperatively.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (reply: ReturnType<typeof renderMarkdown>) => void;
};
worker.onmessage = async event => {
  const reply = renderMarkdown(event.data);
  if (reply.ok) {
    for (const [index, block] of reply.codeBlocks.entries()) {
      const highlighted = await highlightCodeBlock(block.text, block.language);
      const start = `<code data-code-id="${index}">`;
      const from = reply.html.indexOf(start) + start.length;
      const to = reply.html.indexOf('</code>', from);
      if (from >= start.length && to >= from) reply.html = reply.html.slice(0, from) + highlighted + reply.html.slice(to);
    }
  }
  worker.postMessage(reply);
};

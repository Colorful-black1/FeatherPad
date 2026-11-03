import { renderMarkdown, type RenderRequest } from '../features/markdown/parser';

// Each job owns a worker. The host terminates it on cancellation, version change
// or the 2s budget, including cases where the parser cannot yield cooperatively.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (reply: ReturnType<typeof renderMarkdown>) => void;
};
worker.onmessage = event => worker.postMessage(renderMarkdown(event.data));

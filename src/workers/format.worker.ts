import { formatSource, type FormatRequest, type FormatReply } from '../features/search-tools/formatters';

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<FormatRequest>) => void) | null; postMessage: (result: FormatReply) => void };
worker.onmessage = event => { void formatSource(event.data).then(result => worker.postMessage(result)); };

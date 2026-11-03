import { transformText, type TransformRequest, type TransformReply } from '../features/search-tools/text-transforms';
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<TransformRequest>) => void) | null; postMessage: (result: TransformReply) => void };
worker.onmessage = event => worker.postMessage(transformText(event.data));

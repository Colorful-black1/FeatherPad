import { diffSnapshots, type DiffRequest, type DiffReply } from '../features/editor/snapshot-diff';
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<DiffRequest>) => void) | null; postMessage: (result: DiffReply) => void };
worker.onmessage = event => worker.postMessage(diffSnapshots(event.data));

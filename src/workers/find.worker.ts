import { findMatches, type SearchQuery, type SearchScope, type SearchScanResult } from '../features/search-tools/search-query';

export interface FindWorkerRequest {
  requestId: number;
  text: string;
  query: SearchQuery;
  scope: SearchScope | null;
}

export interface FindWorkerResponse {
  requestId: number;
  result: SearchScanResult;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<FindWorkerRequest>) => void) | null;
  postMessage(value: FindWorkerResponse): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = event => {
  const request = event.data;
  workerScope.postMessage({
    requestId: request.requestId,
    result: findMatches(request.query, request.text, request.scope),
  });
};

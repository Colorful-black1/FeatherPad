import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DocumentId } from '../../shared/contracts/files';
import type { DocumentRegistry } from '../editor/documents';
import {
  SEARCH_MATCH_LIMIT, buildReplacements, type SearchMatch, type SearchQuery, type SearchQueryError, type SearchScope,
} from './search-query';
import type { FindWorkerRequest, FindWorkerResponse } from '../../workers/find.worker';

interface ScanSnapshot {
  signature: string;
  version: number;
  matches: readonly SearchMatch[];
  truncated: boolean;
  error: SearchQueryError | null;
}

interface FindBarProps {
  registry: DocumentRegistry;
  id: DocumentId;
  version: number;
  readOnlyReason: string | null;
  open: boolean;
  request: { token: number; version: number; scope: SearchScope | null } | null;
  onClose(): void;
}

interface ScopeChoice {
  token: number;
  version: number;
  enabled: boolean;
  range: SearchScope;
}

function signature(id: DocumentId, version: number, query: SearchQuery, scope: SearchScope | null): string {
  return JSON.stringify([id, version, query, scope]);
}

function matchLabel(registry: DocumentRegistry, id: DocumentId, match: SearchMatch): string {
  const state = registry.getDocument(id)?.state;
  if (!state) return `${match.from}–${match.to}`;
  const line = state.doc.lineAt(match.from);
  const column = match.from - line.from + 1;
  const value = state.sliceDoc(match.from, match.to).replace(/\n/g, '↵').slice(0, 80);
  return `${line.number}:${column}  ${value || '（零长度匹配）'}`;
}

export function FindBar({ registry, id, version, readOnlyReason, open, request, onClose }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  const workerRequest = useRef(0);
  const pendingMatchOffset = useRef<number | null>(null);
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [isRegex, setRegex] = useState(false);
  const [isCaseSensitive, setCaseSensitive] = useState(false);
  const [isWholeWord, setWholeWord] = useState(false);
  const [interpretEscapes, setInterpretEscapes] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice | null>(null);
  const [scan, setScan] = useState<ScanSnapshot | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const query: SearchQuery = { pattern, isRegex, isCaseSensitive, isWholeWord };
  const requestToken = request?.token ?? -1;
  const requestedScope = request?.scope ?? { from: 0, to: registry.getDocument(id)?.state.doc.length ?? 0 };
  const selectedScope = scopeChoice?.token === requestToken ? scopeChoice : {
    token: requestToken,
    version: request?.version ?? version,
    enabled: request?.scope !== null && request !== null,
    range: requestedScope,
  };
  const scopeWasReset = selectedScope.enabled && selectedScope.version !== version;
  const scopeEnabled = selectedScope.enabled && !scopeWasReset;
  const scope = selectedScope.range;
  const activeScope = scopeEnabled ? scope : null;
  const currentSignature = signature(id, version, query, activeScope);
  const freshScan = scan?.signature === currentSignature ? scan : null;

  useEffect(() => {
    if (!open || !request) return;
    queueMicrotask(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open, request, requestToken]);

  useEffect(() => {
    if (!open) return;
    const requestId = ++workerRequest.current;
    const workerQuery: SearchQuery = { pattern, isRegex, isCaseSensitive, isWholeWord };
    const workerScope = scopeEnabled ? { from: scope.from, to: scope.to } : null;
    const workerSignature = signature(id, version, workerQuery, workerScope);
    if (!pattern) {
      registry.highlightSearch(id, []);
      return;
    }
    const state = registry.getDocument(id)?.state;
    if (!state) return;
    const text = state.doc.toString();
    registry.highlightSearch(id, []);
    const worker = new Worker(new URL('../../workers/find.worker.ts', import.meta.url), { type: 'module' });
    const watchdog = window.setTimeout(() => {
      if (requestId !== workerRequest.current) return;
      worker.terminate();
      setScan({
        signature: workerSignature, version, matches: [], truncated: false,
        error: { message: '查找超过时间预算，请缩小范围或提高正则限定', index: 0 },
      });
    }, 5_000);
    worker.onmessage = (event: MessageEvent<FindWorkerResponse>) => {
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(watchdog);
      if (!event.data.result.ok) {
        setScan({ signature: workerSignature, version, matches: [], truncated: false, error: event.data.result.error });
        registry.highlightSearch(id, []);
        return;
      }
      setScan({
        signature: workerSignature, version,
        matches: event.data.result.matches,
        truncated: event.data.result.truncated,
        error: null,
      });
      const preferred = pendingMatchOffset.current;
      pendingMatchOffset.current = null;
      const preferredIndex = preferred === null ? -1
        : event.data.result.matches.findIndex(match => match.from >= preferred);
      setCurrentIndex(preferredIndex >= 0 ? preferredIndex : 0);
      setActionError(null);
    };
    worker.onerror = event => {
      if (requestId !== workerRequest.current) return;
      window.clearTimeout(watchdog);
      setScan({
        signature: workerSignature, version, matches: [], truncated: false,
        error: { message: event.message || '本地查找服务不可用', index: 0 },
      });
    };
    const workerMessage: FindWorkerRequest = { requestId, text, query: workerQuery, scope: workerScope };
    worker.postMessage(workerMessage);
    return () => {
      window.clearTimeout(watchdog);
      worker.terminate();
    };
  }, [open, id, version, pattern, isRegex, isCaseSensitive, isWholeWord, scopeEnabled, scope.from, scope.to, registry]);

  useEffect(() => {
    if (!freshScan || freshScan.error || freshScan.matches.length === 0) {
      registry.highlightSearch(id, []);
      return;
    }
    const index = Math.min(currentIndex, freshScan.matches.length - 1);
    registry.highlightSearch(id, freshScan.matches.map((match, matchIndex) => ({
      from: match.from, to: match.to, current: matchIndex === index,
    })));
    const match = freshScan.matches[index];
    if (match) registry.selectRange(id, match.from, match.to, false);
  }, [freshScan, currentIndex, id, registry]);

  function close() {
    onClose();
    queueMicrotask(() => registry.focus(id));
  }

  function navigate(direction: -1 | 1) {
    if (!freshScan || freshScan.error || freshScan.matches.length === 0) return;
    const count = freshScan.matches.length;
    const next = currentIndex + direction;
    if (next < 0 || next >= count) setStatus(direction > 0 ? '已环绕到第一处匹配' : '已环绕到最后一处匹配');
    else setStatus(null);
    setCurrentIndex((next + count) % count);
  }

  function replaceCurrent(all: boolean) {
    setActionError(null);
    if (readOnlyReason) {
      setActionError(readOnlyReason);
      return;
    }
    if (!freshScan || freshScan.signature !== currentSignature || freshScan.version !== version) {
      setActionError('查找结果已过期，请等待重新查找。');
      return;
    }
    if (freshScan.truncated) {
      setActionError(`匹配超过 ${SEARCH_MATCH_LIMIT.toLocaleString('zh-CN')} 处，请缩小查找范围。`);
      return;
    }
    const state = registry.getDocument(id)?.state;
    if (!state) return;
    const built = buildReplacements(query, state.doc.toString(), activeScope, replacement, interpretEscapes);
    if (!built.ok) {
      setActionError(built.error.message);
      return;
    }
    if (built.truncated) {
      setActionError(`匹配超过 ${SEARCH_MATCH_LIMIT.toLocaleString('zh-CN')} 处，请缩小查找范围。`);
      return;
    }
    if (built.replacements.length === 0) {
      setActionError('当前没有可替换的匹配。');
      return;
    }
    const selectedIndex = Math.min(currentIndex, built.replacements.length - 1);
    const selected = all ? built.replacements : [built.replacements[selectedIndex]!];
    if (!all) {
      const nextMatch = freshScan.matches[(selectedIndex + 1) % freshScan.matches.length];
      const currentChange = selected[0]!;
      pendingMatchOffset.current = selectedIndex + 1 < freshScan.matches.length && nextMatch
        ? nextMatch.from + currentChange.insert.length - (currentChange.to - currentChange.from)
        : nextMatch?.from ?? 0;
    }
    const result = registry.replaceRanges(id, version, selected);
    if (!result.ok) {
      pendingMatchOffset.current = null;
      setActionError(result.error.message);
      return;
    }
    setStatus(all ? `已在一次编辑中替换 ${selected.length.toLocaleString('zh-CN')} 处，可一次撤销` : '已替换当前匹配，可一次撤销');
  }

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
    }
  }

  if (!open) return null;
  const currentMatch = freshScan?.matches[Math.min(currentIndex, Math.max(0, freshScan.matches.length - 1))];
  const resultLabel = !pattern ? '尚未查找'
    : !freshScan ? '查找中…'
      : freshScan.error ? freshScan.error.message
        : freshScan.truncated ? `显示前 ${SEARCH_MATCH_LIMIT.toLocaleString('zh-CN')} 处`
          : `${freshScan.matches.length.toLocaleString('zh-CN')} 处`;
  return <section className="find-bar" aria-label="文件内查找替换" onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }}>
    <div className="find-row">
      <label className="find-field find-query">
        <span>查找</span>
        <input ref={input} aria-label="查找内容" value={pattern}
          onChange={event => { setPattern(event.currentTarget.value); setStatus(null); setActionError(null); }}
          onKeyDown={handleSearchKey} />
      </label>
      <span className={`find-result${freshScan?.error ? ' find-result-error' : ''}`} role="status" aria-live="polite">
        {resultLabel}{!freshScan?.error && freshScan && freshScan.matches.length > 0 ? ` · ${Math.min(currentIndex + 1, freshScan.matches.length)}/${freshScan.matches.length}` : ''}
        {currentMatch ? ` · ${matchLabel(registry, id, currentMatch)}` : ''}
      </span>
      <span className="find-navigation">
        <button className="plain-button" type="button" onClick={() => navigate(-1)} disabled={!freshScan?.matches.length} aria-label="上一个匹配">上一处</button>
        <button className="plain-button" type="button" onClick={() => navigate(1)} disabled={!freshScan?.matches.length} aria-label="下一个匹配">下一处</button>
        <button className="plain-button" type="button" onClick={close} aria-label="关闭查找">关闭</button>
      </span>
    </div>
    <div className="find-row find-options">
      <label className="toolbar-check"><input type="checkbox" checked={isCaseSensitive} onChange={event => setCaseSensitive(event.currentTarget.checked)} />区分大小写</label>
      <label className="toolbar-check"><input type="checkbox" checked={isWholeWord} onChange={event => setWholeWord(event.currentTarget.checked)} />整词</label>
      <label className="toolbar-check"><input type="checkbox" checked={isRegex} onChange={event => setRegex(event.currentTarget.checked)} />安全正则</label>
      <label className="toolbar-check"><input type="checkbox" checked={scopeEnabled} onChange={event => {
        const state = registry.getDocument(id)?.state;
        const selection = state?.selection.main;
        setScopeChoice({
          token: requestToken, version, enabled: event.currentTarget.checked,
          range: {
            from: event.currentTarget.checked ? selection?.from ?? 0 : 0,
            to: event.currentTarget.checked ? selection?.to ?? state?.doc.length ?? 0 : state?.doc.length ?? 0,
          },
        });
        setStatus(event.currentTarget.checked ? '查找范围：当前选区' : '查找范围：全文');
      }} />仅选区</label>
      <span className="find-hint">支持 Unicode 词边界；整词不进行中文分词</span>
    </div>
    <div className="find-row find-replace-row">
      <label className="find-field"><span>替换为</span>
        <input aria-label="替换内容" value={replacement} disabled={!!readOnlyReason}
          onChange={event => setReplacement(event.currentTarget.value)} />
      </label>
      <label className="toolbar-check"><input type="checkbox" checked={interpretEscapes} disabled={!!readOnlyReason}
        onChange={event => setInterpretEscapes(event.currentTarget.checked)} />解释 \n 与 \t</label>
      <span className="find-replace-actions">
        <button className="plain-button" type="button" onClick={() => replaceCurrent(false)}
          disabled={!!readOnlyReason || !freshScan?.matches.length}>替换当前</button>
        <button className="primary-button" type="button" onClick={() => replaceCurrent(true)}
          disabled={!!readOnlyReason || !freshScan?.matches.length || freshScan.truncated}>
          全部替换{freshScan?.matches.length ? `（${freshScan.matches.length}）` : ''}
        </button>
      </span>
      {readOnlyReason && <span className="find-warning">只读文档仅支持查找</span>}
    </div>
    {(freshScan?.error || actionError || status || scopeWasReset || requestedScope && scopeEnabled) && <div className="find-message-row">
      {freshScan?.error && <span role="alert">{freshScan.error.message}{freshScan.error.index >= 0 ? `（位置 ${freshScan.error.index + 1}）` : ''}</span>}
      {actionError && <span role="alert">{actionError}</span>}
      {scopeWasReset && <span role="status">文档已变化，查找范围已安全重置为全文</span>}
      {!scopeWasReset && requestedScope && scopeEnabled && <span role="status">查找范围：当前选区</span>}
      {status && <span role="status">{status}</span>}
    </div>}
    {freshScan && !freshScan.error && freshScan.matches.length > 0 && <details className="find-summary">
      <summary>查看匹配摘要</summary>
      <ol>{freshScan.matches.slice(0, 20).map((match, index) => <li key={`${match.from}:${match.to}:${index}`}>
        <button type="button" onClick={() => setCurrentIndex(index)}>{matchLabel(registry, id, match)}</button>
      </li>)}</ol>
      {freshScan.matches.length > 20 && <p>只显示前20处；单击条目导航当前结果。</p>}
    </details>}
  </section>;
}

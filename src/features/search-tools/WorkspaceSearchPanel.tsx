import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FileRef } from '../../shared/contracts/files';
import type { SearchFileResult, SearchMatch } from '../../bridge/search';
import type { WorkspaceRoot } from '../workspace/store';
import { findMatches, type SearchQuery } from './search-query';
import type { WorkspaceSearchStore } from './workspace-search';
import { WorkspaceFileIndexStore, fuzzyFileMatches } from './file-search';
import { parsePatternLines } from '../workspace/filters';

export interface WorkspaceSearchDraft {
  roots: FileRef[];
  query: SearchQuery;
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  followDirectoryLinks: boolean;
  includeHidden: boolean;
}

function patterns(value: string) {
  return parsePatternLines(value.replace(/,/g, '\n'));
}

function HighlightedName({ name, positions }: { name: string; positions: readonly number[] }) {
  const marked = new Set(positions);
  return <>{name.split('').map((character, index) => marked.has(index)
    ? <mark key={index}>{character}</mark> : character)}</>;
}

export function WorkspaceSearchPanel({ store, roots, request, onSearch, onPreviewReplace, onOpen, onOpenFile, onClose, onChooseFolder, active = true }: {
  store: WorkspaceSearchStore;
  roots: readonly WorkspaceRoot[];
  request: { token: number; mode: 'search' | 'replace' } | null;
  onSearch: (draft: WorkspaceSearchDraft) => void;
  onPreviewReplace: (draft: WorkspaceSearchDraft, replacement: string) => void;
  onOpen: (file: SearchFileResult, match: SearchMatch) => void;
  onOpenFile: (reference: FileRef) => void;
  onClose: () => void;
  onChooseFolder: () => void;
  active?: boolean;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceDetails = useRef<HTMLDetailsElement>(null);
  const appliedRequest = useRef<number | null>(null);
  const [mode, setMode] = useState<'content' | 'files'>('content');
  const [fileQuery, setFileQuery] = useState('');
  const [fileIndexStore] = useState(() => new WorkspaceFileIndexStore());
  const fileIndex = useSyncExternalStore(fileIndexStore.subscribe, fileIndexStore.getSnapshot);
  const fileMatches = useMemo(() => fuzzyFileMatches(fileIndex.entries, fileQuery), [fileIndex.entries, fileQuery]);
  useEffect(() => {
    if (!active) return;
    if (request && appliedRequest.current !== request.token) {
      appliedRequest.current = request.token;
      if (replaceDetails.current) replaceDetails.current.open = request.mode === 'replace';
      queueMicrotask(() => setMode('content'));
    }
    queueMicrotask(() => {
      const target = mode === 'files' ? fileInput.current : input.current;
      target?.focus();
      target?.select();
    });
  }, [active, request, mode]);
  const [pattern, setPattern] = useState(snapshot.options?.query.pattern ?? '');
  const [replacement, setReplacement] = useState('');
  const [isRegex, setIsRegex] = useState(snapshot.options?.query.isRegex ?? false);
  const [isCaseSensitive, setIsCaseSensitive] = useState(snapshot.options?.query.isCaseSensitive ?? false);
  const [isWholeWord, setIsWholeWord] = useState(snapshot.options?.query.isWholeWord ?? false);
  const [includeText, setIncludeText] = useState(snapshot.options?.include.join(', ') ?? '');
  const [excludeText, setExcludeText] = useState(snapshot.options?.exclude.join(', ') ?? '');
  const [respectGitignore, setRespectGitignore] = useState(snapshot.options?.respectGitignore ?? true);
  const [followDirectoryLinks, setFollowDirectoryLinks] = useState(snapshot.options?.followDirectoryLinks ?? false);
  const [includeHidden, setIncludeHidden] = useState(snapshot.options?.includeHidden ?? false);
  const [selectedRoots, setSelectedRoots] = useState<Set<string>>(() =>
    new Set(snapshot.options?.roots.map(root => root.grantId) ?? roots.map(root => root.grant.grantId)));
  const previousRoots = useRef(new Set(roots.map(root => root.grant.grantId)));
  useEffect(() => {
    const previous = previousRoots.current;
    previousRoots.current = new Set(roots.map(root => root.grant.grantId));
    setSelectedRoots(current => new Set(roots.filter(root => current.has(root.grant.grantId)
      || !previous.has(root.grant.grantId)).map(root => root.grant.grantId)));
  }, [roots]);
  useEffect(() => {
    if (!active) {
      fileIndexStore.cancel();
      return;
    }
    if (mode !== 'files') return;
    if (roots.length === 0) {
      fileIndexStore.cancel();
      return;
    }
    const selected = roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.grant);
    if (selected.length === 0) {
      fileIndexStore.cancel();
      return;
    }
    fileIndexStore.ensure(selected);
  }, [active, fileIndexStore, mode, roots, selectedRoots]);
  useEffect(() => () => fileIndexStore.cancel(), [fileIndexStore]);
  const busy = snapshot.phase === 'running' || snapshot.phase === 'cancelling';
  const query: SearchQuery = { pattern, isRegex, isCaseSensitive, isWholeWord };
  const validation = (() => {
    if (!pattern) return '请输入至少一个字符。';
    if (!roots.some(root => selectedRoots.has(root.grant.grantId))) return '请选择至少一个搜索文件夹。';
    try { patterns(includeText); patterns(excludeText); }
    catch (cause) { return cause instanceof Error ? cause.message : '文件过滤规则无效。'; }
    const checked = findMatches(query, '');
    return checked.ok ? null : checked.error.message;
  })();

  function currentDraft(): WorkspaceSearchDraft {
    return {
      roots: roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.grant),
      query,
      include: patterns(includeText),
      exclude: patterns(excludeText),
      respectGitignore,
      followDirectoryLinks,
      includeHidden,
    };
  }

  function submit() {
    if (validation || busy) return;
    onSearch(currentDraft());
  }

  function previewReplacement() {
    if (validation || busy || snapshot.phase === 'running' || snapshot.phase === 'cancelling') return;
    onPreviewReplace(currentDraft(), replacement);
  }

  return <section className="workspace-search-panel" aria-labelledby="workspace-search-title">
    <header>
      <div><p className="welcome-eyebrow">目录搜索</p><h2 id="workspace-search-title">在文件和文件夹中查找</h2></div>
      <button type="button" className="plain-button" aria-label="关闭目录搜索" onClick={onClose}>关闭</button>
    </header>
    <div className="workspace-search-modes" role="group" aria-label="搜索模式">
      <button type="button" className="plain-button" aria-pressed={mode === 'content'}
        onClick={() => setMode('content')}>搜索内容</button>
      <button type="button" className="plain-button" aria-pressed={mode === 'files'}
        onClick={() => setMode('files')}>搜索文件</button>
    </div>
    <form hidden={mode !== 'content'} onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="workspace-search-pattern">搜索内容
        <input ref={input} type="search" value={pattern} onChange={event => setPattern(event.currentTarget.value)}
          placeholder="输入要查找的文字" />
      </label>
      {roots.length === 0 ? <div className="search-empty-state">
        <p>先打开文件夹才能搜索。</p>
        <button type="button" className="primary-button" onClick={onChooseFolder}>打开文件夹…</button>
      </div> : <p className="search-scope-summary">搜索位置：{roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.displayName).join('、') || '尚未选择文件夹'}</p>}
      <details className="search-replace-details" ref={replaceDetails}><summary>跨文件替换</summary>
      <label className="workspace-search-replacement">替换为
        <input type="text" value={replacement} onChange={event => setReplacement(event.currentTarget.value)}
          placeholder="留空表示删除匹配内容" />
      </label>
      <button type="button" className="plain-button" disabled={!!validation || busy || roots.length === 0}
        onClick={previewReplacement}>预览跨文件替换</button>
      <small>先预览匹配内容，确认后再修改文件。</small>
      </details>
      <details className="search-advanced"><summary>搜索选项与范围{isRegex || isCaseSensitive || isWholeWord || includeText || excludeText || includeHidden || followDirectoryLinks || !respectGitignore ? '（已自定义）' : ''}</summary>
      <div className="workspace-search-options">
        <label><input type="checkbox" checked={isCaseSensitive} onChange={event => setIsCaseSensitive(event.currentTarget.checked)} />区分大小写</label>
        <label><input type="checkbox" checked={isWholeWord} onChange={event => setIsWholeWord(event.currentTarget.checked)} />整词</label>
        <label><input type="checkbox" checked={isRegex} onChange={event => setIsRegex(event.currentTarget.checked)} />正则</label>
        <label><input type="checkbox" checked={respectGitignore} onChange={event => setRespectGitignore(event.currentTarget.checked)} />遵循 gitignore</label>
        <label><input type="checkbox" checked={includeHidden} onChange={event => setIncludeHidden(event.currentTarget.checked)} />包含隐藏项</label>
        <label><input type="checkbox" checked={followDirectoryLinks} onChange={event => setFollowDirectoryLinks(event.currentTarget.checked)} />跟随目录链接</label>
      </div>
      <fieldset className="workspace-search-roots"><legend>搜索范围</legend>
        {roots.map(root => <label key={root.grant.grantId}><input type="checkbox"
          checked={selectedRoots.has(root.grant.grantId)} onChange={event => setSelectedRoots(current => {
            const next = new Set(current);
            if (event.currentTarget.checked) next.add(root.grant.grantId); else next.delete(root.grant.grantId);
            return next;
          })} />{root.displayName}</label>)}
      </fieldset>
      <div className="workspace-search-globs">
        <label>包含文件规则<input aria-label="包含 glob" value={includeText} onChange={event => setIncludeText(event.currentTarget.value)}
          placeholder="*.ts, src/**" /></label>
        <label>排除文件规则<input aria-label="排除 glob" value={excludeText} onChange={event => setExcludeText(event.currentTarget.value)}
          placeholder="*.min.js, dist/**" /></label>
      </div>
      <small>例如 *.md 匹配 Markdown 文件，docs/** 匹配 docs 内的文件；多条规则用逗号分隔。最多 256 条，每条不超过 1024 字符。</small>
      </details>
      <div className="workspace-search-actions">
        {busy ? <button type="button" className="plain-button" onClick={() => void store.cancel()}>
          {snapshot.phase === 'cancelling' ? '正在取消…' : '取消搜索'}</button>
          : <button type="submit" className="primary-button" disabled={!!validation || roots.length === 0}>开始搜索</button>}
        {validation && pattern.length > 0 && roots.length > 0 ? <span role="alert">{validation}</span>
          : !pattern && roots.length > 0 && <span className="search-instruction">输入文字，搜索所选文件夹内的文件。</span>}
      </div>
    </form>
    {mode === 'files' && <form className="workspace-search-file-form" onSubmit={event => event.preventDefault()}>
      <label className="workspace-search-pattern">文件名
        <input ref={fileInput} type="search" value={fileQuery} onChange={event => setFileQuery(event.currentTarget.value)}
          placeholder="输入文件名，支持模糊匹配" />
      </label>
      {roots.length === 0 ? <div className="search-empty-state">
        <p>先打开文件夹才能搜索文件。</p>
        <button type="button" className="primary-button" onClick={onChooseFolder}>打开文件夹…</button>
      </div> : <p className="search-scope-summary">搜索位置：{roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.displayName).join('、') || '尚未选择文件夹'}</p>}
      {roots.length > 1 && <fieldset className="workspace-search-roots">
        <legend>搜索范围</legend>
        {roots.map(root => <label key={root.grant.grantId}><input type="checkbox"
          checked={selectedRoots.has(root.grant.grantId)} onChange={event => setSelectedRoots(current => {
            const next = new Set(current);
            if (event.currentTarget.checked) next.add(root.grant.grantId); else next.delete(root.grant.grantId);
            return next;
          })} />{root.displayName}</label>)}
      </fieldset>}
      <div className="workspace-file-index-actions">
        <p className="search-instruction">按文件名模糊匹配；遵循 gitignore，默认跳过隐藏项和目录链接。</p>
        <button type="button" className="plain-button" disabled={fileIndex.phase === 'loading'}
          onClick={() => {
            const selected = roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.grant);
            if (selected.length > 0) fileIndexStore.refresh(selected);
          }}>刷新索引</button>
      </div>
      {roots.length > 0 && !roots.some(root => selectedRoots.has(root.grant.grantId))
        && <p className="field-error">请选择至少一个搜索文件夹。</p>}
      {fileIndex.phase === 'loading' && <p className="search-instruction" role="status">正在读取文件列表…</p>}
      {fileIndex.phase === 'failed' && <p className="field-error" role="alert">
        {fileIndex.error ?? '文件列表读取失败。'}
        <button type="button" className="plain-button" onClick={() => {
          const selected = roots.filter(root => selectedRoots.has(root.grant.grantId)).map(root => root.grant);
          if (selected.length > 0) fileIndexStore.ensure(selected);
        }}>重试</button>
      </p>}
    </form>}
    <div className="workspace-search-status" aria-live="polite" hidden={mode !== 'content'}>
      {snapshot.progress && `${snapshot.progress.scannedFiles.toLocaleString('zh-CN')} 个文件 · ${snapshot.progress.totalMatches.toLocaleString('zh-CN')} 个匹配 · ${Math.floor(snapshot.progress.elapsedMs / 100) / 10} 秒`}
      {snapshot.phase === 'failed' && <span role="alert">{snapshot.error?.message}</span>}
      {snapshot.phase === 'complete' && <span>
        {snapshot.cancelled ? '已取消，结果不完整' : snapshot.truncated ? '已达到结果上限，结果不完整' : `完成 · ${snapshot.elapsedMs} ms`}
      </span>}
    </div>
    {mode === 'files' && fileIndex.phase === 'ready' && <div className="workspace-search-status" aria-live="polite">
      <span>已索引 {fileIndex.entries.length.toLocaleString('zh-CN')} 个文件</span>
      <span>{fileQuery.trim()
        ? `${fileMatches.length.toLocaleString('zh-CN')}${fileMatches.length >= 200 ? '+' : ''} 个匹配`
        : '输入文件名开始搜索'}</span>
      {fileIndex.truncated && <span className="replace-warning">文件索引达到20,000个上限，结果可能不完整。</span>}
    </div>}
    {snapshot.skipped.length > 0 && <details className="workspace-search-skips" hidden={mode !== 'content'}><summary>跳过与限制</summary>
      <ul>{snapshot.skipped.map(item => <li key={item.reason}>{item.reason}：{item.count}</li>)}</ul></details>}
    {mode === 'files' && fileIndex.skipped.length > 0 && <details className="workspace-search-skips">
      <summary>索引跳过与限制</summary>
      <ul>{fileIndex.skipped.map(item => <li key={item.reason}>{item.reason}：{item.count}</li>)}</ul>
    </details>}
    <div className="workspace-search-results" aria-label="目录搜索结果" hidden={mode !== 'content'}>
      {snapshot.phase === 'complete' && snapshot.files.length === 0 && <p>没有匹配结果。</p>}
      {snapshot.files.map(file => {
        const dirty = snapshot.dirtyFiles.some(item => item.ref.grantId === file.ref.grantId
          && item.ref.relativePath === file.ref.relativePath);
        return <details key={`${file.ref.grantId}-${file.ref.relativePath}`} open>
          <summary>
            <span>{file.displayName}</span>
            {dirty && <strong className="search-source-badge">未保存缓冲</strong>}
            <small>{file.matches.length}{file.truncated ? '+' : ''} · {file.encoding}</small>
          </summary>
          <p className="workspace-search-path">{file.displayPath}</p>
          <ol>{file.matches.map((match, index) => <li key={`${match.start}-${index}`}>
            <button type="button" className="plain-button" onClick={() => onOpen(file, match)}>
              <span>{match.line}:{match.column}</span>
              <code>{match.prefixTruncated ? '…' : ''}{match.snippet}{match.suffixTruncated ? '…' : ''}</code>
            </button>
          </li>)}</ol>
        </details>;
      })}
    </div>
    {mode === 'files' && <div className="workspace-search-results workspace-file-results" aria-label="文件搜索结果">
      {fileIndex.phase === 'loading' ? <p className="search-instruction">正在读取文件列表…</p>
        : fileQuery.trim() === '' ? <p className="search-instruction">输入文件名开始模糊搜索。</p>
          : fileIndex.phase === 'failed' ? <p className="search-instruction">文件列表不可用，请重试。</p>
            : fileMatches.length === 0 ? <p>没有匹配文件。</p>
              : <>
                {fileMatches.length >= 200 && <p className="search-instruction">仅显示前 200 个匹配，请继续输入以缩小范围。</p>}
                <ul>{fileMatches.map(match => <li key={`${match.entry.ref.grantId}/${match.entry.ref.relativePath}`}>
                  <button type="button" className="plain-button" onClick={() => onOpenFile(match.entry.ref)}>
                    <span className="file-search-name"><HighlightedName name={match.entry.displayName} positions={match.positions} /></span>
                    <small className="file-search-path" title={match.entry.displayPath}>{match.entry.displayPath}</small>
                  </button>
                </li>)}</ul>
              </>}
    </div>}
  </section>;
}

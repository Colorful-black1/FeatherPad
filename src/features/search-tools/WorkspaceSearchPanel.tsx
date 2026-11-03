import { useState, useSyncExternalStore } from 'react';
import type { FileRef } from '../../shared/contracts/files';
import type { SearchFileResult, SearchMatch } from '../../bridge/search';
import type { WorkspaceRoot } from '../workspace/store';
import { findMatches, type SearchQuery } from './search-query';
import type { WorkspaceSearchStore } from './workspace-search';

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
  return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean).slice(0, 256);
}

export function WorkspaceSearchPanel({ store, roots, onSearch, onPreviewReplace, onOpen, onClose }: {
  store: WorkspaceSearchStore;
  roots: readonly WorkspaceRoot[];
  onSearch: (draft: WorkspaceSearchDraft) => void;
  onPreviewReplace: (draft: WorkspaceSearchDraft, replacement: string) => void;
  onOpen: (file: SearchFileResult, match: SearchMatch) => void;
  onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
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
  const busy = snapshot.phase === 'running' || snapshot.phase === 'cancelling';
  const query: SearchQuery = { pattern, isRegex, isCaseSensitive, isWholeWord };
  const validation = (() => {
    if (!pattern) return '请输入至少一个字符。';
    if (selectedRoots.size === 0) return '请选择至少一个搜索范围。';
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
      <div><p className="welcome-eyebrow">WORKSPACE SEARCH</p><h2 id="workspace-search-title">在文件和文件夹中查找</h2></div>
      <button type="button" className="plain-button" aria-label="关闭目录搜索" onClick={onClose}>关闭</button>
    </header>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="workspace-search-pattern">搜索内容
        <input autoFocus type="search" value={pattern} onChange={event => setPattern(event.currentTarget.value)}
          placeholder="文字或安全正则表达式" />
      </label>
      <label className="workspace-search-replacement">替换为
        <input type="text" value={replacement} onChange={event => setReplacement(event.currentTarget.value)}
          placeholder="留空表示删除匹配内容" />
      </label>
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
        <label>包含 glob<input value={includeText} onChange={event => setIncludeText(event.currentTarget.value)}
          placeholder="*.ts, src/**" /></label>
        <label>排除 glob<input value={excludeText} onChange={event => setExcludeText(event.currentTarget.value)}
          placeholder="*.min.js, dist/**" /></label>
      </div>
      <div className="workspace-search-actions">
        {busy ? <button type="button" className="plain-button" onClick={() => void store.cancel()}>
          {snapshot.phase === 'cancelling' ? '正在取消…' : '取消搜索'}</button>
          : <button type="submit" className="primary-button" disabled={!!validation || roots.length === 0}>开始搜索</button>}
        <button type="button" className="plain-button" disabled={!!validation || busy || roots.length === 0}
          onClick={previewReplacement}>预览跨文件替换</button>
        {validation && <span role="alert">{validation}</span>}
      </div>
    </form>
    <div className="workspace-search-status" aria-live="polite">
      {snapshot.progress && `${snapshot.progress.scannedFiles.toLocaleString('zh-CN')} 个文件 · ${snapshot.progress.totalMatches.toLocaleString('zh-CN')} 个匹配 · ${Math.floor(snapshot.progress.elapsedMs / 100) / 10} 秒`}
      {snapshot.phase === 'failed' && <span role="alert">{snapshot.error?.message}</span>}
      {snapshot.phase === 'complete' && <span>
        {snapshot.cancelled ? '已取消，结果不完整' : snapshot.truncated ? '已达到结果上限，结果不完整' : `完成 · ${snapshot.elapsedMs} ms`}
      </span>}
    </div>
    {snapshot.skipped.length > 0 && <details className="workspace-search-skips"><summary>跳过与限制</summary>
      <ul>{snapshot.skipped.map(item => <li key={item.reason}>{item.reason}：{item.count}</li>)}</ul></details>}
    <div className="workspace-search-results" aria-label="目录搜索结果">
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
  </section>;
}

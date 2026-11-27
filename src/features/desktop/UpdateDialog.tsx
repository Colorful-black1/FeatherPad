import { useEffect, useRef } from 'react';
import {
  updatePercent, type UpdateSnapshot,
} from './updates';

export function UpdateDialog({ snapshot, onDownload, onInstall, onClose }: {
  snapshot: UpdateSnapshot;
  onDownload: () => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const update = snapshot.update;
  const busy = snapshot.phase === 'downloading' || snapshot.phase === 'preparing' || snapshot.phase === 'installing';
  const locked = snapshot.phase === 'preparing' || snapshot.phase === 'installing';
  const percent = updatePercent(snapshot.progress);
  const published = update?.date ? new Date(update.date) : null;
  const publishedText = published && !Number.isNaN(published.getTime())
    ? published.toLocaleString('zh-CN') : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    primary.current?.focus();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (busy) return;
    primary.current?.focus();
  }, [busy, snapshot.phase]);

  if (!update) return null;

  const status = (() => {
    switch (snapshot.phase) {
      case 'downloading':
        return percent === null
          ? `正在下载 v${update.version}…`
          : `正在下载 v${update.version}：${percent}%`;
      case 'ready':
        return `v${update.version} 已下载，安装后应用会自动重启。`;
      case 'preparing':
        return '正在写入恢复副本并准备安装…';
      case 'installing':
        return '正在安装更新，应用即将退出并自动重启…';
      case 'installed':
        return '更新已安装。请重新启动应用以使用新版本。';
      default:
        return `发现新版本 v${update.version}。`;
    }
  })();

  return <dialog ref={dialog} className="update-dialog" aria-labelledby="update-dialog-title"
    aria-describedby="update-dialog-description" onCancel={event => {
      event.preventDefault();
      if (!locked) onClose();
    }}>
    <header>
      <p className="welcome-eyebrow">应用更新</p>
      <h2 id="update-dialog-title">{snapshot.phase === 'installed' ? '更新已安装' : '发现新版本'}</h2>
    </header>
    <div className="update-body">
      <dl className="update-versions">
        <div><dt>当前版本</dt><dd>v{snapshot.currentVersion}</dd></div>
        <div><dt>新版本</dt><dd>v{update.version}</dd></div>
        {publishedText && <div><dt>发布时间</dt><dd>{publishedText}</dd></div>}
      </dl>
      <p id="update-dialog-description" className="update-status" aria-live="polite">{status}</p>
      {snapshot.progress && (snapshot.phase === 'downloading' || snapshot.phase === 'ready') && <div className="update-progress">
        <div role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent ?? undefined} aria-valuetext={percent === null
            ? `${snapshot.progress.downloaded.toLocaleString()} 字节`
            : `${percent}%`}>
          <span style={{ width: `${percent ?? 12}%` }} data-indeterminate={percent === null} />
        </div>
        <small>{snapshot.progress.total === null
          ? `${snapshot.progress.downloaded.toLocaleString()} 字节`
          : `${snapshot.progress.downloaded.toLocaleString()} / ${snapshot.progress.total.toLocaleString()} 字节`}</small>
      </div>}
      {update.notes && <section className="update-notes" aria-label="更新说明">
        <h3>更新说明</h3>
        <p>{update.notes}</p>
      </section>}
      <p className="update-warning">安装更新会关闭并重启应用。未保存内容会先写入本地恢复副本，重启后可恢复。请先关闭其他轻羽窗口。</p>
      {snapshot.error && <p className="settings-message" role="alert">{snapshot.error}</p>}
    </div>
    <footer>
      <button type="button" className="plain-button" disabled={locked} onClick={onClose}>
        {snapshot.phase === 'installed' ? '关闭' : '稍后'}
      </button>
      {snapshot.phase === 'available' && <button ref={primary} type="button" className="primary-button"
        onClick={onDownload}>{snapshot.error ? '重试下载' : '下载并安装'}</button>}
      {snapshot.phase === 'downloading' && <button ref={primary} type="button" className="primary-button" disabled>
        正在下载…
      </button>}
      {snapshot.phase === 'ready' && <button ref={primary} type="button" className="primary-button"
        onClick={onInstall}>{snapshot.error ? '重试安装' : '重启并安装'}</button>}
      {snapshot.phase === 'preparing' && <button ref={primary} type="button" className="primary-button" disabled>
        正在准备…
      </button>}
      {snapshot.phase === 'installing' && <button ref={primary} type="button" className="primary-button" disabled>
        正在安装…
      </button>}
      {snapshot.phase === 'installed' && <button ref={primary} type="button" className="primary-button" disabled>
        已安装
      </button>}
    </footer>
  </dialog>;
}

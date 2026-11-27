import { useSyncExternalStore } from 'react';
import { updates, updateAvailable } from './updates';

function timestamp(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
}

export function AboutSettings() {
  const snapshot = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const checking = snapshot.phase === 'checking';
  const busy = checking || snapshot.phase === 'downloading' || snapshot.phase === 'preparing'
    || snapshot.phase === 'installing' || updateAvailable(snapshot);
  const status = (() => {
    if (!__UPDATER_CONFIGURED__) return '自动更新尚未启用：需要先配置更新签名公钥。';
    switch (snapshot.phase) {
      case 'checking': return '正在检查更新…';
      case 'up-to-date': return `已是最新版本（v${snapshot.currentVersion}）。`;
      case 'available':
      case 'downloading':
      case 'preparing':
      case 'installing':
        return snapshot.update
          ? `发现新版本 v${snapshot.update.version}。请关闭设置，点击顶部的更新按钮继续。`
          : '发现新版本。';
      case 'ready': return `v${snapshot.update?.version ?? ''} 已下载，请关闭设置并使用顶部更新按钮安装。`;
      case 'installed': return '更新已安装，请重新启动应用。';
      case 'error':
      case 'unsupported':
        return snapshot.error ?? '自动更新暂不可用。';
      default:
        return snapshot.lastCheckedAt ? '尚未发现新版本。' : '启动时会自动检查更新。';
    }
  })();
  const checked = timestamp(snapshot.lastCheckedAt);

  return <section className="settings-about" aria-label="关于轻羽">
    <h3>关于</h3>
    <dl>
      <dt>版本</dt><dd>v{__APP_VERSION__}</dd>
      <dt>更新方式</dt><dd>安装版启动时自动检查 GitHub Releases；便携版请手动下载新版本。</dd>
    </dl>
    <p>检查更新只读取 GitHub 上的版本清单，不上传文档内容或使用记录。</p>
    <div className="settings-about-actions">
      <button type="button" className="plain-button" disabled={busy || !__UPDATER_CONFIGURED__}
        onClick={() => void updates.check({ automatic: false })}>
        {checking ? '正在检查…' : '检查更新'}
      </button>
      {updateAvailable(snapshot) && snapshot.update && <span className="settings-about-badge">
        新版本 v{snapshot.update.version}
      </span>}
    </div>
    <p className="settings-about-status" aria-live="polite">{status}</p>
    {checked && <p className="settings-about-checked">上次检查：{checked}</p>}
  </section>;
}

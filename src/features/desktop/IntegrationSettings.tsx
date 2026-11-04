import { useEffect, useState } from 'react';
import {
  desktopBridge, isDesktopRuntime,
  type DesktopIntegrationStatus,
} from '../../bridge/desktop';

export function IntegrationSettings() {
  const [status, setStatus] = useState<DesktopIntegrationStatus | null>(null);
  const [fileAssociation, setFileAssociation] = useState(false);
  const [contextMenu, setContextMenu] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const native = isDesktopRuntime();

  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktopBridge.getIntegration().then(result => {
      if (!active) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setStatus(result.value);
      setFileAssociation(result.value.fileAssociation);
      setContextMenu(result.value.contextMenu);
    });
    return () => { active = false; };
  }, [native]);

  async function save() {
    if (!native || working) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const result = await desktopBridge.setIntegration(fileAssociation, contextMenu);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setStatus(result.value);
      setFileAssociation(result.value.fileAssociation);
      setContextMenu(result.value.contextMenu);
      setMessage('当前用户的系统集成已按选择更新；Windows 默认应用保持不变。');
    } catch {
      setError('系统集成结果未确认。重新读取状态后即可安全重试。');
    } finally {
      setWorking(false);
    }
  }

  if (!native) {
    return <section className="settings-integration" aria-label="Windows 系统集成">
      <h3>Windows 系统集成</h3>
      <p>安装版和便携版桌面程序可在此显式启用文件“打开方式”候选及资源管理器右键菜单。</p>
    </section>;
  }

  return <section className="settings-integration" aria-label="Windows 系统集成">
    <h3>Windows 系统集成</h3>
    <p>两项均默认关闭，只写入当前用户注册表。不会修改 Windows 默认应用或 UserChoice，不会抢占文件打开方式。</p>
    <fieldset disabled={working}>
      <label><input type="checkbox" checked={fileAssociation} disabled={working}
        onChange={event => setFileAssociation(event.currentTarget.checked)} />
        在“打开方式”中显示轻羽（{status?.supportedExtensions.join(' ') ?? '支持的文本扩展名'}）</label>
      <label><input type="checkbox" checked={contextMenu} disabled={working}
        onChange={event => setContextMenu(event.currentTarget.checked)} />
        为支持的文件和文件夹显示“用轻羽打开”资源管理器菜单</label>
    </fieldset>
    {status && <dl>
      <dt>运行模式</dt><dd>{status.runtimeMode === 'portable' ? '便携版' : '安装版'}</dd>
      <dt>数据目录</dt><dd><code>{status.dataRoot}</code></dd>
      <dt>程序路径</dt><dd><code>{status.executablePath}</code></dd>
    </dl>}
    <button className="plain-button" disabled={working || status === null} onClick={() => void save()}>
      {working ? '正在更新…' : '更新系统集成'}
    </button>
    {error && <p className="notice" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateDialog } from './UpdateDialog';
import type { UpdateSnapshot } from './updates';

const update = {
  version: '1.0.1', currentVersion: '1.0.0', date: '2026-11-27T00:00:00Z', notes: '修复若干问题。',
};

function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'available', automatic: false, currentVersion: '1.0.0', update,
    progress: null, error: null, lastCheckedAt: '2026-11-27T00:00:00Z', ...overrides,
  };
}

function render(value: UpdateSnapshot) {
  return renderToStaticMarkup(<UpdateDialog snapshot={value}
    onDownload={() => {}} onInstall={() => {}} onClose={() => {}} />);
}

describe('UpdateDialog', () => {
  it('shows versions, release notes and the download action', () => {
    const html = render(snapshot());
    expect(html).toContain('v1.0.0');
    expect(html).toContain('v1.0.1');
    expect(html).toContain('修复若干问题。');
    expect(html).toContain('下载并安装');
    expect(html).toContain('安装更新会关闭并重启应用');
  });

  it('shows determinate download progress and disables the primary action', () => {
    const html = render(snapshot({
      phase: 'downloading', progress: { downloaded: 50, total: 100 },
    }));
    expect(html).toContain('正在下载 v1.0.1：50%');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('disabled');
  });

  it('asks to restart after the download and blocks closing while installing', () => {
    expect(render(snapshot({ phase: 'ready', progress: { downloaded: 100, total: 100 } })))
      .toContain('重启并安装');
    const installing = render(snapshot({ phase: 'installing' }));
    expect(installing).toContain('正在安装更新，应用即将退出并自动重启');
    expect(installing).toContain('disabled');
  });

  it('keeps an error visible with a retry action', () => {
    const html = render(snapshot({ phase: 'ready', error: '更新包签名校验失败，未安装。' }));
    expect(html).toContain('更新包签名校验失败，未安装。');
    expect(html).toContain('重试安装');
  });
});

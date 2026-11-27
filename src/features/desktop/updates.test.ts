import { describe, expect, it, vi } from 'vitest';
import {
  UpdateCoordinator, updatePercent, type NativeUpdate, type UpdateAdapter,
} from './updates';

function nativeUpdate(overrides: Partial<NativeUpdate> = {}): NativeUpdate & {
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    version: '1.0.1',
    currentVersion: '1.0.0',
    date: '2026-11-27T00:00:00Z',
    body: '修复若干问题。',
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } as NativeUpdate & {
    download: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function coordinator(adapter: UpdateAdapter, options: {
  runtime?: () => Promise<'installed' | 'portable' | 'unknown'>;
  configured?: boolean;
  now?: () => number;
} = {}) {
  return new UpdateCoordinator(
    adapter,
    options.runtime ?? (async () => 'installed'),
    options.configured ?? true,
    options.now ?? (() => 1_000),
    () => true,
  );
}

describe('UpdateCoordinator', () => {
  it('reports an up-to-date check and records the last check time', async () => {
    const c = coordinator({ check: vi.fn(async () => null) });
    await c.check({ automatic: true });
    expect(c.getSnapshot()).toMatchObject({
      phase: 'up-to-date', automatic: true, lastCheckedAt: '1970-01-01T00:00:01.000Z', error: null,
    });
  });

  it('exposes the available version, notes and current version', async () => {
    const update = nativeUpdate();
    const c = coordinator({ check: vi.fn(async () => update) });
    await c.check();
    expect(c.getSnapshot()).toMatchObject({
      phase: 'available',
      update: { version: '1.0.1', currentVersion: '1.0.0', notes: '修复若干问题。' },
      error: null,
    });
  });

  it('keeps automatic check failures quiet but visible in the stored error', async () => {
    const c = coordinator({ check: vi.fn(async () => { throw new Error('network timeout'); }) });
    await c.check({ automatic: true });
    expect(c.getSnapshot()).toMatchObject({
      phase: 'error', automatic: true, error: '无法连接更新服务器，请检查网络后重试。',
    });
  });

  it('does not call the network before a signing key is configured', async () => {
    const check = vi.fn(async () => nativeUpdate());
    const c = coordinator({ check }, { configured: false });
    await c.check();
    expect(check).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({
      phase: 'unsupported', error: '更新签名公钥尚未配置，自动更新暂不可用。',
    });
  });

  it('does not offer automatic installs for portable mode', async () => {
    const check = vi.fn(async () => nativeUpdate());
    const c = coordinator({ check }, { runtime: async () => 'portable' });
    await c.check();
    expect(check).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({
      phase: 'unsupported', error: '便携版不提供自动更新，请从 GitHub Releases 手动下载新版本。',
    });
  });

  it('publishes download progress and reaches the ready state', async () => {
    let clock = 0;
    const update = nativeUpdate();
    update.download.mockImplementation(async onEvent => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    const c = coordinator({ check: vi.fn(async () => update) }, { now: () => (clock += 200) });
    await c.check();
    await c.download();
    expect(c.getSnapshot()).toMatchObject({
      phase: 'ready', progress: { downloaded: 100, total: 100 }, error: null,
    });
    expect(updatePercent(c.getSnapshot().progress)).toBe(100);
  });

  it('keeps the update available after a download failure so it can be retried', async () => {
    const update = nativeUpdate();
    update.download.mockRejectedValueOnce(new Error('network timeout'));
    const c = coordinator({ check: vi.fn(async () => update) });
    await c.check();
    await c.download();
    expect(c.getSnapshot()).toMatchObject({
      phase: 'available', update: { version: '1.0.1' }, error: '无法连接更新服务器，请检查网络后重试。',
    });
  });

  it('prepares recovery before launching the installer', async () => {
    const update = nativeUpdate();
    const order: string[] = [];
    update.install.mockImplementation(async () => { order.push('install'); });
    const c = coordinator({ check: vi.fn(async () => update) });
    await c.check();
    await c.download();
    const prepare = vi.fn(async () => { order.push('prepare'); return null; });
    await c.install(prepare);
    expect(order).toEqual(['prepare', 'install']);
    expect(c.getSnapshot().phase).toBe('installed');
  });

  it('does not install when recovery preparation fails', async () => {
    const update = nativeUpdate();
    const c = coordinator({ check: vi.fn(async () => update) });
    await c.check();
    await c.download();
    await c.install(async () => '恢复副本写入失败。');
    expect(update.install).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', error: '恢复副本写入失败。' });
  });

  it('restores editing state when the installer fails', async () => {
    const update = nativeUpdate();
    update.install.mockRejectedValueOnce(new Error('installer failed'));
    const c = coordinator({ check: vi.fn(async () => update) });
    await c.check();
    await c.download();
    const onFailure = vi.fn();
    await c.install(async () => null, onFailure);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({
      phase: 'ready', error: '无法启动更新安装程序，请稍后重试。',
    });
  });

  it('releases the previous update resource before checking again', async () => {
    const update = nativeUpdate();
    const check = vi.fn(async (): Promise<NativeUpdate | null> => update);
    const c = coordinator({ check });
    await c.check();
    check.mockResolvedValueOnce(null);
    await c.check();
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().phase).toBe('up-to-date');
  });

  it('does not start a second concurrent check', async () => {
    let release!: (value: NativeUpdate | null) => void;
    const pending = new Promise<NativeUpdate | null>(resolve => { release = resolve; });
    const check = vi.fn(async () => pending);
    const c = coordinator({ check });
    const first = c.check();
    const second = c.check();
    release(null);
    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

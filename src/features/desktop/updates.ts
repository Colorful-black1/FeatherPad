import { desktopBridge, isDesktopRuntime } from '../../bridge/desktop';

export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading'
  | 'ready' | 'preparing' | 'installing' | 'installed' | 'error' | 'unsupported';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateSnapshot {
  phase: UpdatePhase;
  automatic: boolean;
  currentVersion: string;
  update: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface NativeUpdate {
  readonly version: string;
  readonly currentVersion: string;
  readonly date?: string | undefined;
  readonly body?: string | undefined;
  download(onEvent: (event: {
    event: 'Started'; data: { contentLength?: number };
  } | { event: 'Progress'; data: { chunkLength: number } } | { event: 'Finished' }) => void,
  options?: { timeout?: number }): Promise<void>;
  install(options?: { restartAfterInstall?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateAdapter {
  check(): Promise<NativeUpdate | null>;
}

export type RuntimeMode = 'installed' | 'portable' | 'unknown';
export type PrepareUpdate = () => Promise<string | null>;

const MAX_NOTES = 12_000;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const initial = (): UpdateSnapshot => ({
  phase: 'idle', automatic: false, currentVersion: __APP_VERSION__, update: null,
  progress: null, error: null, lastCheckedAt: null,
});

function cleanText(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.replace(/\0/g, '').trim();
  return text ? text.slice(0, max) : null;
}

function friendlyError(error: unknown, mode: 'check' | 'download' | 'install' = 'check'): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/signature|public key|pubkey|verify|minisign|decode.*key/i.test(message)) {
    return '更新包签名校验失败，未安装。';
  }
  if (/installer|execute|restart/i.test(message) && mode === 'install') {
    return '无法启动更新安装程序，请稍后重试。';
  }
  if (/404|not found|no release/i.test(message)) return '更新服务器尚未发布可用版本。';
  if (/network|connect|timeout|timed out|request|dns|tls|http/i.test(message)) {
    return '无法连接更新服务器，请检查网络后重试。';
  }
  if (mode === 'install') return '安装更新失败，当前版本未改变。';
  if (mode === 'download') return '更新下载失败，请重试。';
  return '检查更新失败，请稍后重试。';
}

export function createNativeUpdateAdapter(): UpdateAdapter {
  return {
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) return null;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date,
        body: update.body,
        download: (onEvent, options) => update.download(onEvent, {
          timeout: DOWNLOAD_TIMEOUT_MS, ...options,
        }),
        install: options => update.install(options),
        close: () => update.close(),
      };
    },
  };
}

async function detectRuntimeMode(): Promise<RuntimeMode> {
  if (!isDesktopRuntime()) return 'unknown';
  const result = await desktopBridge.getIntegration();
  return result.ok ? result.value.runtimeMode : 'unknown';
}

export class UpdateCoordinator {
  private readonly listeners = new Set<() => void>();
  private snapshot = initial();
  private native: NativeUpdate | null = null;
  private checking = false;
  private lastProgressPublish = 0;
  private downloaded = 0;
  private total: number | null = null;

  constructor(
    private readonly adapter: UpdateAdapter = createNativeUpdateAdapter(),
    private readonly runtimeMode: () => Promise<RuntimeMode> = detectRuntimeMode,
    private readonly configured: boolean = __UPDATER_CONFIGURED__,
    private readonly now: () => number = Date.now,
    private readonly desktop: () => boolean = isDesktopRuntime,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  async check(options: { automatic?: boolean } = {}): Promise<void> {
    const automatic = options.automatic === true;
    if (this.checking || this.snapshot.phase === 'downloading'
      || this.snapshot.phase === 'preparing' || this.snapshot.phase === 'installing') return;
    if (!this.desktop()) {
      this.publish({ ...initial(), phase: 'unsupported', automatic,
        error: '仅桌面安装版支持自动更新，请在桌面应用中使用。' });
      return;
    }
    if (!this.configured) {
      this.publish({ ...this.snapshot, phase: 'unsupported', automatic,
        error: '更新签名公钥尚未配置，自动更新暂不可用。' });
      return;
    }
    this.checking = true;
    this.publish({ ...this.snapshot, phase: 'checking', automatic, error: null });
    try {
      const mode = await this.runtimeMode();
      if (mode === 'portable') {
        this.publish({ ...initial(), phase: 'unsupported', automatic,
          error: '便携版不提供自动更新，请从 GitHub Releases 手动下载新版本。' });
        return;
      }
      if (mode === 'unknown') {
        this.publish({ ...initial(), phase: 'error', automatic,
          error: '无法确认当前运行模式，自动更新暂不可用。' });
        return;
      }
      await this.closeNative();
      const update = await this.adapter.check();
      const lastCheckedAt = new Date(this.now()).toISOString();
      if (!update) {
        this.publish({ ...initial(), phase: 'up-to-date', automatic, lastCheckedAt });
        return;
      }
      const version = cleanText(update.version, 64);
      if (!version) {
        this.publish({ ...initial(), phase: 'error', automatic, lastCheckedAt,
          error: '更新服务器返回的版本信息无效。' });
        return;
      }
      this.native = update;
      this.publish({
        phase: 'available', automatic, currentVersion: __APP_VERSION__,
        update: {
          version,
          currentVersion: cleanText(update.currentVersion, 64) ?? __APP_VERSION__,
          date: cleanText(update.date, 64),
          notes: cleanText(update.body, MAX_NOTES),
        },
        progress: null, error: null, lastCheckedAt,
      });
    } catch (error) {
      this.publish({ ...initial(), phase: 'error', automatic,
        lastCheckedAt: new Date(this.now()).toISOString(), error: friendlyError(error) });
    } finally {
      this.checking = false;
    }
  }

  async download(): Promise<void> {
    if (!this.native || this.snapshot.phase !== 'available') return;
    this.downloaded = 0;
    this.total = null;
    this.lastProgressPublish = 0;
    this.publish({ ...this.snapshot, phase: 'downloading', progress: { downloaded: 0, total: null }, error: null });
    try {
      await this.native.download(event => {
        if (event.event === 'Started') {
          this.total = event.data.contentLength && event.data.contentLength > 0
            ? event.data.contentLength : null;
        } else if (event.event === 'Progress') {
          this.downloaded += event.data.chunkLength;
        } else {
          if (this.total !== null) this.downloaded = this.total;
        }
        this.publishProgress(event.event === 'Finished');
      });
      if (this.total !== null) this.downloaded = this.total;
      this.publish({ ...this.snapshot, phase: 'ready', progress: { downloaded: this.downloaded, total: this.total }, error: null });
    } catch (error) {
      this.publish({ ...this.snapshot, phase: 'available', progress: null, error: friendlyError(error, 'download') });
    }
  }

  async install(prepare: PrepareUpdate, onFailure?: () => void): Promise<void> {
    if (!this.native || this.snapshot.phase !== 'ready') return;
    this.publish({ ...this.snapshot, phase: 'preparing', error: null });
    let failure: string | null;
    try {
      failure = await prepare();
    } catch {
      onFailure?.();
      failure = '无法准备安装更新，当前版本未改变。';
    }
    if (failure) {
      this.publish({ ...this.snapshot, phase: 'ready', error: failure });
      return;
    }
    this.publish({ ...this.snapshot, phase: 'installing', error: null });
    try {
      await this.native.install({ restartAfterInstall: true });
      // On Windows the process exits before this resolves. Keeping a terminal
      // state makes non-Windows and test environments behave predictably.
      this.publish({ ...this.snapshot, phase: 'installed', progress: null, error: null });
    } catch (error) {
      onFailure?.();
      this.publish({ ...this.snapshot, phase: 'ready', error: friendlyError(error, 'install') });
    }
  }

  async close(): Promise<void> {
    await this.closeNative();
    this.publish(initial());
  }

  private publishProgress(finished: boolean) {
    const now = this.now();
    if (!finished && now - this.lastProgressPublish < 100) return;
    this.lastProgressPublish = now;
    this.publish({ ...this.snapshot, progress: { downloaded: this.downloaded, total: this.total } });
  }

  private async closeNative() {
    const native = this.native;
    this.native = null;
    if (!native) return;
    try {
      await native.close();
    } catch {
      // Releasing an already-closed update resource is harmless.
    }
  }

  private publish(snapshot: UpdateSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
}

export const updates = new UpdateCoordinator();

export function updatePercent(progress: UpdateProgress | null): number | null {
  if (!progress || progress.total === null || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(progress.downloaded / progress.total * 100)));
}

export function updateAvailable(snapshot: UpdateSnapshot): boolean {
  return snapshot.update !== null && ['available', 'downloading', 'ready', 'preparing', 'installing'].includes(snapshot.phase);
}

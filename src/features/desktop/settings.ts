import { settingsBridge } from '../../bridge/settings';
import { favoritesSetting } from '../workspace/favorites';
import { files } from '../../bridge/files';
import type { FileRef, ResultEnvelope, SaveAsRequest } from '../../shared/contracts/files';
import type { JsonValue, LoadedSettings, LocalFonts, RawSettings, SavedSettings } from '../../shared/contracts/settings';
import type { WorkspaceStore } from '../workspace/store';
import { defaultSettings, exportSettings, isSettingKey, isSettingValue, mergeSettings, resetSettings,
  settingsChanges, languagePreferencesSetting, type SettingKey, type Settings } from './settings-schema';

export interface SettingsSnapshot extends ReturnType<typeof mergeSettings> {
  user: RawSettings;
  draft: RawSettings | null;
  session: RawSettings;
  version: number | null;
  revision: string | null;
  saving: boolean;
  message: string | null;
  error: string | null;
  warning: string | null;
  workspaceWarning: string | null;
  fonts: LocalFonts | null;
  fontWarning: string | null;
}
const fail = (message: string): Extract<ResultEnvelope<never>, { ok: false }> =>
  ({ ok: false, error: { code: 'CONFLICT', message, retryable: false } });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export class SettingsCoordinator {
  private user: RawSettings = {};
  private workspace: RawSettings = {};
  private session: RawSettings = {};
  private draft: RawSettings | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: SettingsSnapshot = { ...mergeSettings(), user: {}, draft: null, session: {}, version: null,
    revision: null, saving: false, message: null, error: null, warning: null, workspaceWarning: null,
    fonts: null, fontWarning: null };
  private loadGeneration = 0;
  private workspaceGeneration = 0;
  private exportRequest: SaveAsRequest | null = null;
  private unsubscribe: (() => void) | null = null;
  private root: FileRef | null = null;
  private persistenceQueue: Promise<unknown> = Promise.resolve();
  private pendingFontSize: number | null = null;
  private fontPersistence: Promise<ResultEnvelope<unknown>> | null = null;

  constructor(private readonly bridge: typeof settingsBridge = settingsBridge,
    private readonly exportFile: typeof files.saveAs = files.saveAs) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;

  start(
    workspace: Pick<WorkspaceStore, 'subscribe' | 'getSnapshot'>,
    options: { load?: boolean } = {},
  ): () => void {
    if (this.unsubscribe) return () => this.stop();
    const sync = () => {
      const root = workspace.getSnapshot().root?.grant ?? null;
      if (same(root, this.root)) return;
      this.root = root;
      void this.reloadWorkspace();
    };
    this.unsubscribe = workspace.subscribe(sync);
    window.addEventListener('focus', this.onFocus);
    sync();
    if (options.load !== false) void this.load();
    void this.bridge.fonts().then(fonts => {
      if (!this.unsubscribe) return;
      if (fonts.ok) this.publish({ fonts: fonts.value });
      else this.publish({ fontWarning: '无法核对本机字体，已保留本地后备字体。' });
    });
    return () => this.stop();
  }

  stop() {
    ++this.loadGeneration; ++this.workspaceGeneration;
    this.unsubscribe?.(); this.unsubscribe = null;
    window.removeEventListener('focus', this.onFocus);
    this.root = null;
  }

  async load(keepPreview = true): Promise<ResultEnvelope<LoadedSettings>> {
    const generation = ++this.loadGeneration;
    const result = await this.bridge.load();
    if (generation !== this.loadGeneration) return fail('已忽略过期设置读取。');
    if (!result.ok) { this.publish({ error: `无法读取设置：${result.error.message} 当前仅本次生效。` }); return result; }
    const changes = keepPreview && this.draft ? settingsChanges(this.user, this.draft) : [];
    this.user = structuredClone(result.value.settings);
    if (!keepPreview) this.draft = null;
    else if (this.draft) {
      this.draft = structuredClone(this.user);
      for (const change of changes) {
        if (change.after === undefined) delete this.draft[change.key];
        else this.draft[change.key] = structuredClone(change.after);
      }
    }
    this.publish({ version: result.value.version, revision: result.value.revision, warning: result.value.warning,
      error: null,
      message: changes.length ? '已读取当前配置并保留本次修改，请核对后保存。' : null });
    return result;
  }

  async reloadWorkspace(root = this.root) {
    const generation = ++this.workspaceGeneration;
    this.workspace = {};
    this.publish({ workspaceWarning: null });
    if (!root) return;
    const result = await this.bridge.workspace(root);
    if (generation !== this.workspaceGeneration) return;
    if (result.ok) { this.workspace = result.value.settings; this.publish({ workspaceWarning: result.value.warning }); }
    else this.publish({ workspaceWarning: `工作区设置未能读取：${result.error.message}` });
  }

  beginPreview() { this.draft = structuredClone(this.user); this.publish({ error: null, message: null }); }
  cancelPreview() { this.draft = null; this.publish({ error: null, message: null }); }

  setPreview(key: SettingKey, value: Settings[SettingKey]) {
    if (!isSettingValue(key, value)) return fail('设置值无效，预览保持原值。');
    this.draft = { ...(this.draft ?? this.user), [key]: value };
    this.publish({ error: null, message: '正在预览，尚未保存。' });
    return { ok: true as const, value: null };
  }

  importPreview(imported: RawSettings) {
    this.draft = { ...(this.draft ?? this.user), ...structuredClone(imported) };
    this.publish({ error: null, message: '已载入导入预览；请核对有效值和诊断后保存。' });
  }

  reset(keys: readonly SettingKey[]) {
    this.draft = resetSettings(this.draft ?? this.user, keys);
    this.publish({ error: null, message: '已预览默认值，未识别字段仍保留。' });
  }

  setSession<K extends SettingKey>(key: K, value: Settings[K]) {
    if (!isSettingValue(key, value)) return;
    this.session = { ...this.session, [key]: value };
    this.publish({ message: '此选择仅本次会话生效。' });
  }
  clearSession() { this.session = {}; this.publish({ message: null }); }

  setPersisted<K extends SettingKey>(key: K, value: Settings[K]): Promise<ResultEnvelope<unknown>> {
    if (!isSettingValue(key, value)) return Promise.resolve(fail('设置值无效，未保存。'));
    // Apply immediately, then persist through the same revision-checked path as
    // the settings dialog so a restart keeps the new value.
    this.session = { ...this.session, [key]: value };
    this.publish({ error: null, message: null });
    return this.enqueuePersistence(async () => {
      let result: ResultEnvelope<SavedSettings>;
      try { result = await this.persistUserValue(key, value); }
      catch { result = fail('设置保存结果未确认，请重新读取设置后再试。'); }
      if (!result.ok) {
        this.publish({ error: `${result.error.message} 此选择仅本次生效。` });
        return result;
      }
      this.publish({ message: '设置已保存。', error: null });
      return result;
    });
  }

  usePreviewForSession() {
    if (!this.draft) return;
    for (const change of settingsChanges(this.user, this.draft)) {
      if (!isSettingKey(change.key)) continue;
      const value = change.after ?? defaultSettings[change.key];
      if (isSettingValue(change.key, value)) this.session[change.key] = value;
    }
    this.draft = null;
    this.publish({ message: '当前预览仅本次会话生效，配置文件未修改。', error: null });
  }

  async save(): Promise<ResultEnvelope<unknown>> {
    if (this.snapshot.saving) return fail('设置正在保存，请等待结果。');
    if (this.snapshot.version === null) return fail('尚未读取设置版本，请先重新读取；当前预览仍保留。');
    const captured = structuredClone(this.draft ?? this.user);
    const localChanges = settingsChanges(this.user, captured);
    this.publish({ saving: true, error: null, message: null });
    try {
      return await this.enqueuePersistence(async () => {
        if (this.snapshot.version === null) return fail('设置版本尚未载入。');
        const settings = structuredClone(this.user);
        for (const change of localChanges) {
          if (change.after === undefined) delete settings[change.key];
          else settings[change.key] = structuredClone(change.after);
        }
        let request = {
          expectedVersion: this.snapshot.version,
          expectedRevision: this.snapshot.revision,
          settings,
        };
        let result = await this.bridge.save(request);
        if (!result.ok && result.error.code === 'IPC_UNAVAILABLE') {
          const observed = await this.bridge.load();
          if (observed.ok && observed.value.version === request.expectedVersion + 1
            && same(observed.value.settings, request.settings)
            && observed.value.revision) result = { ok: true, value: { version: observed.value.version, revision: observed.value.revision } };
        }
        if (!result.ok && result.error.code === 'CONFLICT'
          && (this.snapshot.version !== request.expectedVersion || this.snapshot.revision !== request.expectedRevision)) {
          const merged = structuredClone(this.user);
          for (const change of localChanges) {
            if (change.after === undefined) delete merged[change.key];
            else merged[change.key] = structuredClone(change.after);
          }
          request = {
            expectedVersion: this.snapshot.version,
            expectedRevision: this.snapshot.revision,
            settings: merged,
          };
          result = await this.bridge.save(request);
        }
        if (!result.ok) { this.publish({ error: `${result.error.message} 当前预览仅本次生效。` }); return result; }
        if (this.snapshot.version !== request.expectedVersion || this.snapshot.revision !== request.expectedRevision) {
          const result = fail('保存回执晚于另一次配置读取；预览仍保留，请重新核对配置。');
          this.publish({ error: result.error.message }); return result;
        }
        for (const change of localChanges) if (isSettingKey(change.key)) delete this.session[change.key];
        this.user = request.settings;
        // A late acknowledgment only commits its captured configuration, never a newer preview.
        if (same(this.draft, captured)) this.draft = null;
        this.publish({ version: result.value.version, revision: result.value.revision, error: null,
          message: this.draft ? '已保存捕获的设置；还有新的预览未保存。' : '设置已保存。' });
        return result;
      });
    } finally { this.publish({ saving: false }); }
  }

  setFontSize(size: number): Promise<ResultEnvelope<unknown>> {
    if (!isSettingValue('fontSize', size)) return Promise.resolve(fail('编辑字号必须是8–40之间的整数。'));
    this.setSession('fontSize', size);
    this.pendingFontSize = size;
    if (this.fontPersistence) return this.fontPersistence;
    const operation = this.enqueuePersistence(async (): Promise<ResultEnvelope<unknown>> => {
      let result: ResultEnvelope<unknown> = { ok: true, value: null };
      try {
        while (this.pendingFontSize !== null) {
          const captured = this.pendingFontSize;
          this.pendingFontSize = null;
          result = await this.persistFontSize(captured);
          if (!result.ok) break;
        }
      } catch {
        result = fail('字号保存结果未确认，请重新读取设置后再试。');
      }
      if (!result.ok) {
        this.pendingFontSize = null;
        this.publish({ error: `${result.error.message} 编辑字号仅本次生效。` });
      }
      return result;
    }).finally(() => { if (this.fontPersistence === operation) this.fontPersistence = null; });
    this.fontPersistence = operation;
    return operation;
  }

  flushFontSize(): Promise<ResultEnvelope<unknown>> {
    return this.fontPersistence ?? Promise.resolve({ ok: true, value: null });
  }

  private async persistFontSize(size: number): Promise<ResultEnvelope<SavedSettings>> {
    return this.persistUserValue('fontSize', size);
  }

  private async persistUserValue<K extends SettingKey>(key: K, value: Settings[K]): Promise<ResultEnvelope<SavedSettings>> {
    if (this.snapshot.version === null) return fail('尚未读取到设置版本。');
    const request = { expectedVersion: this.snapshot.version, expectedRevision: this.snapshot.revision,
      settings: { ...structuredClone(this.user), [key]: value } };
    let result = await this.bridge.save(request);
    if (!result.ok && result.error.code === 'IPC_UNAVAILABLE') {
      const observed = await this.bridge.load();
      if (observed.ok && observed.value.version === request.expectedVersion + 1
        && same(observed.value.settings, request.settings) && observed.value.revision) {
        result = { ok: true, value: { version: observed.value.version, revision: observed.value.revision } };
      }
    }
    if (!result.ok) return result;
    if (this.snapshot.version !== request.expectedVersion || this.snapshot.revision !== request.expectedRevision) {
      return fail('设置保存回执晚于另一次配置读取，请重新核对设置。');
    }
    const previewChanges = this.draft ? settingsChanges(this.user, this.draft) : [];
    this.user = request.settings;
    if (this.draft) {
      this.draft = structuredClone(this.user);
      for (const change of previewChanges) {
        if (change.after === undefined) delete this.draft[change.key];
        else this.draft[change.key] = structuredClone(change.after);
      }
    }
    if (this.session[key] === value) delete this.session[key];
    this.publish({ version: result.value.version, revision: result.value.revision, error: null });
    return result;
  }

  async updatePersistedValue(key: string, update: JsonValue | ((current: JsonValue | undefined) => JsonValue)): Promise<ResultEnvelope<SavedSettings>> {
    if (key !== 'recentHistoryItems' && key !== languagePreferencesSetting && key !== favoritesSetting) return fail('此内部设置键不允许独立写入。');
    return this.enqueuePersistence(async () => {
      if (this.snapshot.version === null) {
        const result = fail('尚未读取到设置版本；此修改仅本次生效。');
        this.publish({ error: result.error.message });
        return result;
      }
      const resolve = () => typeof update === 'function' ? update(structuredClone(this.user[key])) : update;
      let value: JsonValue;
      try { value = resolve(); } catch { return fail('内部偏好无效或已达到容量限制；原数据已保留，此修改仅本次生效。'); }
      let captured: RawSettings = { ...structuredClone(this.user), [key]: structuredClone(value) };
      if (!Object.hasOwn(captured, key)) return fail('内部偏好写入失败。');
      let request = { expectedVersion: this.snapshot.version, expectedRevision: this.snapshot.revision, settings: captured };
      let result = await this.bridge.save(request);
      if (!result.ok && result.error.code === 'IPC_UNAVAILABLE') {
        const observed = await this.bridge.load();
        if (observed.ok && observed.value.version === request.expectedVersion + 1
          && same(observed.value.settings, captured) && observed.value.revision) {
          result = { ok: true, value: { version: observed.value.version, revision: observed.value.revision } };
        }
      }
      if (!result.ok && result.error.code === 'CONFLICT') {
        const observed = await this.load();
        if (!observed.ok || this.snapshot.version === null) return result;
        try { value = resolve(); } catch { return fail('内部偏好无效或已达到容量限制；原数据已保留，此修改仅本次生效。'); }
        captured = { ...structuredClone(this.user), [key]: structuredClone(value) };
        request = { expectedVersion: this.snapshot.version, expectedRevision: this.snapshot.revision, settings: captured };
        result = await this.bridge.save(request);
      }
      if (!result.ok) {
        this.publish({ error: `内部偏好未能保存：${result.error.message}` });
        return result;
      }
      this.user = captured;
      if (this.draft) this.draft = { ...structuredClone(this.draft), [key]: structuredClone(value) };
      this.publish({ version: result.value.version, revision: result.value.revision, error: null });
      return result;
    });
  }

  async export(): Promise<ResultEnvelope<unknown>> {
    if (!this.exportRequest) {
      const text = exportSettings(this.draft ?? this.user);
      if (new TextEncoder().encode(text).byteLength > 65_536) return fail('导出设置超过64KiB，请先减少配置内容。');
      this.exportRequest = Object.freeze<SaveAsRequest>({ documentId: crypto.randomUUID() as SaveAsRequest['documentId'], requestId: crypto.randomUUID(),
        documentVersion: 0, intent: 'copy', text, format: { encoding: 'utf-8', bom: 'none', lineEnding: 'lf' },
        newlineMap: { documentVersion: 0, endings: Array.from({ length: text.split('\n').length - 1 }, () => 'lf' as const) } });
    }
    const request = this.exportRequest;
    if (!request) return fail('导出快照未准备完成，请重试。');
    const result = await this.exportFile(request);
    if (!result.ok && result.error.code === 'IPC_UNAVAILABLE') {
      this.publish({ error: '导出结果未确认；重试将核对同一份快照和请求。' }); return result;
    }
    this.exportRequest = null;
    this.publish(result.ok ? { message: `设置已导出：${result.value.metadata.displayPath}`, error: null } : { error: result.error.message });
    return result;
  }

  private readonly onFocus = () => { void this.reloadWorkspace(); };

  private enqueuePersistence<T>(run: () => Promise<T>): Promise<T> {
    const scheduled = this.persistenceQueue.then(run, run);
    this.persistenceQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private publish(patch: Partial<SettingsSnapshot> = {}) {
    const preview: RawSettings = {};
    if (this.draft) for (const change of settingsChanges(this.user, this.draft)) {
      if (isSettingKey(change.key)) preview[change.key] = change.after ?? defaultSettings[change.key];
    }
    const merged = mergeSettings(this.draft ?? this.user, this.workspace, { ...this.session, ...preview });
    const fonts = patch.fonts ?? this.snapshot.fonts;
    let fontWarning = patch.fontWarning ?? this.snapshot.fontWarning;
    if (fonts) {
      const found = fonts.families.some(name => name.toLocaleLowerCase() === merged.settings.fontFamily.toLocaleLowerCase());
      fontWarning = found ? null : fonts.truncated ? '本机字体列表超过显示上限，无法确认此字体；使用本地后备。'
        : `未找到本机字体“${merged.settings.fontFamily}”，将使用 Consolas 等本地后备字体。`;
    }
    this.snapshot = { ...this.snapshot, ...patch, ...merged, user: this.user, draft: this.draft,
      session: this.session, fontWarning };
    this.listeners.forEach(listener => listener());
  }
}

export const settings = new SettingsCoordinator();

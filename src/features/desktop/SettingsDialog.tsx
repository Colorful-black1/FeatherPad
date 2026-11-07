import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { JsonValue, RawSettings } from '../../shared/contracts/settings';
import { defaultSettings, mergeSettings, parseSettingsImport, settingDefinitions, settingsChanges,
  type SettingDefinition, type SettingGroup, type SettingKey, type Settings, type SettingSource } from './settings-schema';
import type { SettingsCoordinator } from './settings';
import { IntegrationSettings } from './IntegrationSettings';
import { SettingsFontPicker, SettingsSelect } from './SettingsControls';

const sourceNames: Record<SettingSource, string> = { default: '内置默认', user: '用户设置', workspace: '工作区设置', session: '本次预览 / 会话' };
const display = (value: JsonValue | undefined) => value === undefined ? '恢复上层值' : JSON.stringify(value).slice(0, 160);
const settingGroups = [['all', '全部'], ['appearance', '外观'], ['editor', '编辑器'], ['privacy', '隐私']] as const;
const groupNames: Record<SettingGroup, string> = { appearance: '外观', editor: '编辑器', privacy: '隐私' };
function readableValue(value: Settings[keyof Settings]) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  const names: Record<string, string> = { system: '跟随系统', light: '浅色', dark: '深色', none: '关闭', current: '仅当前行', all: '全部可见' };
  return typeof value === 'string' ? names[value] ?? value : String(value);
}

function SettingField({ definition, value, error, fontFamilies, onChange }: {
  definition: SettingDefinition; value: Settings[keyof Settings]; onChange: (value: Settings[keyof Settings]) => void;
  error: string | undefined; fontFamilies: readonly string[];
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current && input.current.value !== String(value)) input.current.value = String(value); }, [value]);
  const id = `setting-label-${definition.key}`;
  const accessibility = { invalid: !!error, describedBy: error ? `setting-error-${definition.key}` : undefined };
  if (definition.kind === 'boolean') return <input aria-invalid={!!error} aria-describedby={accessibility.describedBy}
    id={id} type="checkbox" aria-label={definition.label}
    checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />;
  if (definition.kind === 'theme') return <SettingsSelect id={id} label={definition.label} value={String(value)}
    options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
    onChange={next => onChange(next as Settings['theme'])} {...accessibility} />;
  if (definition.kind === 'tab') return <SettingsSelect id={id} label={definition.label} value={String(value)}
    options={[{ value: '2', label: '2 列' }, { value: '4', label: '4 列' }, { value: '8', label: '8 列' }]}
    onChange={next => onChange(Number(next))} {...accessibility} />;
  if (definition.kind === 'whitespace') return <SettingsSelect id={id} label={definition.label} value={String(value)}
    options={[{ value: 'none', label: '关闭' }, { value: 'current', label: '仅当前行' }, { value: 'all', label: '全部可见' }]}
    onChange={next => onChange(next as Settings['whitespaceMode'])} {...accessibility} />;
  if (definition.kind === 'font') return <SettingsFontPicker id={id} label={definition.label} value={String(value)}
    options={fontFamilies} onChange={next => onChange(next)} {...accessibility} />;
  const numeric = definition.kind === 'number';
  return <input aria-invalid={!!error} aria-describedby={accessibility.describedBy} ref={input} id={id}
    aria-label={definition.label} defaultValue={String(value)} type={numeric ? 'number' : 'text'}
    min={numeric ? definition.key === 'fontSize' ? 8 : 1.2 : undefined}
    max={numeric ? definition.key === 'fontSize' ? 40 : 2.5 : undefined}
    step={numeric ? definition.key === 'fontSize' ? 1 : 0.05 : undefined} required maxLength={128}
    onChange={event => onChange(numeric ? Number(event.currentTarget.value) : event.currentTarget.value)} />;
}

export function SettingsDialog({ coordinator, onClose, onShortcuts, suspended = false }: {
  coordinator: SettingsCoordinator; onClose: () => void; onShortcuts: () => void; suspended?: boolean;
}) {
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const categories = useRef<HTMLDivElement>(null);
  const categoryId = useId();
  const search = useRef<HTMLInputElement>(null);
  const importing = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<SettingGroup | 'all' | 'system'>('all');
  const [horizontal, setHorizontal] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [imported, setImported] = useState<RawSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [working, setWorking] = useState(false);
  const [inputEpoch, setInputEpoch] = useState(0);
  const busy = snapshot.saving || working;
  const userValues = mergeSettings(snapshot.draft ?? snapshot.user).settings;
  const changes = settingsChanges(snapshot.user, snapshot.draft ?? snapshot.user);
  const searching = query.trim().length > 0;
  const definitions = settingDefinitions.filter(definition => (searching || group === 'all' || definition.group === group)
    && query.trim().toLocaleLowerCase().split(/\s+/).every(token =>
      `${definition.label} ${definition.key} ${definition.keywords}`.toLocaleLowerCase().includes(token)));
  const fontFamilies = useMemo(() => {
    const families = snapshot.fonts?.families ?? [];
    const current = userValues.fontFamily;
    return current && !families.some(name => name.toLocaleLowerCase() === current.toLocaleLowerCase())
      ? [current, ...families] : families;
  }, [snapshot.fonts, userValues.fontFamily]);

  useEffect(() => {
    coordinator.beginPreview();
  }, [coordinator]);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!suspended) { element?.showModal(); search.current?.focus(); }
    else element?.close();
    return () => element?.close();
  }, [suspended]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const sync = () => setHorizontal(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  function navigateCategory(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (busy || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey) return;
    const categoryCount = settingGroups.length + 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? categoryCount - 1
      : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % categoryCount
        : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + categoryCount - 1) % categoryCount : null;
    const selected = next === null ? undefined
      : next === settingGroups.length ? ['system', '系统'] as const : settingGroups[next];
    if (!selected || next === null) return;
    event.preventDefault();
    setGroup(selected[0]);
    categories.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  function cancel() { coordinator.cancelPreview(); onClose(); }
  async function run(action: () => Promise<unknown>) {
    if (working || snapshot.saving) return;
    setWorking(true); setError(null);
    try { await action(); } finally { setWorking(false); }
  }
  async function readImport(file: File | undefined) {
    if (!file) return;
    if (file.size > 65_536) { setError('导入文件超过64KiB；当前配置未改变。'); return; }
    const result = parseSettingsImport(await file.text());
    if (!result.ok) { setError(result.error.message); return; }
    setError(null); setImported(result.value);
  }

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <header><h2 id="settings-title">设置</h2><label className="settings-search">搜索设置
      <input ref={search} type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="主题、字体、缩进…" /></label></header>
    <div className="settings-content">
      <nav aria-label="设置分类">
        <div ref={categories} role="tablist" aria-label="设置分类" aria-orientation={horizontal ? 'horizontal' : 'vertical'} className="settings-tabs">
          {settingGroups.map(([id, label], index) => <button key={id} id={`${categoryId}-${id}`} role="tab"
            className="plain-button" aria-selected={group === id} aria-controls={`${categoryId}-panel`}
            tabIndex={group === id ? 0 : -1} disabled={busy}
            onKeyDown={event => navigateCategory(event, index)} onClick={() => setGroup(id)}>{label}</button>)}
          <button id={`${categoryId}-system`} role="tab" className="plain-button"
            aria-selected={group === 'system'} aria-controls={`${categoryId}-panel`}
            tabIndex={group === 'system' ? 0 : -1} disabled={busy}
            onKeyDown={event => navigateCategory(event, settingGroups.length)}
            onClick={() => setGroup('system')}>系统</button>
        </div>
      </nav>
      <div id={`${categoryId}-panel`} className="settings-fields" role="tabpanel" aria-labelledby={`${categoryId}-${group}`} tabIndex={0}>
        <p className="settings-intro">修改会即时预览。保存写入本机配置；取消会还原本次预览。工作区设置和文档临时选择可能覆盖用户值。</p>
        {searching && <p className="settings-search-scope" role="status">在全部分类中搜索 · {definitions.length} 项结果</p>}
        <fieldset disabled={busy}>
          {definitions.map(definition => <div className="settings-row" key={definition.key}>
            <div><label htmlFor={`setting-label-${definition.key}`}>{definition.label}</label>
              {searching && <small>{groupNames[definition.group]}</small>}
              {definition.description && <small>{definition.description}</small>}</div>
            <SettingField key={`${definition.key}-${inputEpoch}`} definition={definition} value={userValues[definition.key]} error={fieldErrors[definition.key]} fontFamilies={fontFamilies} onChange={value => {
              const result = coordinator.setPreview(definition.key, value);
              setFieldErrors(previous => {
                const next = { ...previous };
                if (result.ok) delete next[definition.key];
                else next[definition.key] = definition.kind === 'number'
                  ? definition.key === 'fontSize' ? '请输入 8–40 之间的整数字号，尚未应用。' : '请输入 1.2–2.5 之间的行高，尚未应用。'
                  : result.error.message;
                return next;
              });
            }} />
            <button className="plain-button" aria-label={`重置${definition.label}`} onClick={() => {
              coordinator.reset([definition.key]); setError(null);
              setFieldErrors(previous => { const next = { ...previous }; delete next[definition.key]; return next; });
              setInputEpoch(value => value + 1);
            }}>重置</button>
            {fieldErrors[definition.key] && <p className="settings-field-error" id={`setting-error-${definition.key}`} role="alert">{fieldErrors[definition.key]}</p>}
            {snapshot.settings[definition.key] !== userValues[definition.key] && <p className="settings-override">
              当前生效：{readableValue(snapshot.settings[definition.key])}（被{sourceNames[snapshot.sources[definition.key]]}覆盖）</p>}
            <details className="settings-value-details"><summary>配置详情</summary>
              <p>默认：{readableValue(defaultSettings[definition.key])} · 来源：{sourceNames[snapshot.sources[definition.key]]}</p>
              <p>当前有效：{readableValue(snapshot.settings[definition.key])}</p>
            </details>
          </div>)}
          {definitions.length === 0 && <p>没有匹配设置。</p>}
        </fieldset>
        <pre className="settings-font-preview" aria-label="字体预览">轻羽 FeatherPad{`\n`}Aa 0123456789 中文标点，等宽缩进。</pre>
        {!searching && (group === 'all' || group === 'system') && <IntegrationSettings />}
        {snapshot.fontWarning && <p className="notice" role="note">{snapshot.fontWarning}</p>}
        {snapshot.warning && <p className="notice" role="note">{snapshot.warning}</p>}
        {snapshot.workspaceWarning && <p className="notice" role="note">{snapshot.workspaceWarning}</p>}
        {snapshot.diagnostics.length > 0 && <details><summary>配置诊断（{snapshot.diagnostics.length}）</summary><ul>
          {snapshot.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.source}-${diagnostic.key}-${index}`}>
            {sourceNames[diagnostic.source]} · {diagnostic.key}：{diagnostic.message}</li>)}</ul></details>}
        {imported && <section className="settings-import" aria-label="导入设置预览"><h3>导入预览</h3>
          <p>配置不会执行命令。未识别字段将保留；无效值会给出诊断并回退。应用预览后仍需保存。</p>
          <ul>{settingsChanges(snapshot.draft ?? snapshot.user, { ...(snapshot.draft ?? snapshot.user), ...imported }).map(change =>
            <li key={change.key}>{change.key}：{display(change.before)} → {display(change.after)}</li>)}</ul>
          <button className="plain-button" disabled={busy} onClick={() => { coordinator.importPreview(imported); setImported(null); }}>应用导入预览</button>
          <button className="plain-button" disabled={busy} onClick={() => setImported(null)}>取消导入</button></section>}
        {changes.length > 0 && <p className="settings-changes">本次预览修改了 {changes.length} 项，尚未保存。</p>}
      </div>
    </div>
    <footer>
      <div className="settings-tools">
        <button className="plain-button" disabled={busy} onClick={onShortcuts}>自定义快捷键…</button>
        <input ref={importing} type="file" accept=".json,application/json" aria-label="导入设置文件" hidden
          onChange={event => { void readImport(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
        <button className="plain-button" disabled={busy} onClick={() => importing.current?.click()}>导入…</button>
        <button className="plain-button" disabled={busy} onClick={() => void run(() => coordinator.export())}>导出当前预览…</button>
        <button className="plain-button" disabled={busy} onClick={() => {
          coordinator.reset(settingDefinitions.filter(definition => group === 'all' || definition.group === group).map(definition => definition.key));
          setError(null); setFieldErrors({}); setInputEpoch(value => value + 1);
        }}>
          {group === 'all' ? '重置全部已知设置' : '重置本组'}</button>
        <button className="plain-button" disabled={busy} onClick={() => void run(async () => { await coordinator.load(); await coordinator.reloadWorkspace(); })}>重新读取</button>
      </div>
      {(error || snapshot.error) && <p className="settings-message" role="alert">{error ?? snapshot.error}</p>}
      {Object.keys(fieldErrors).length > 0 && <div className="settings-error-links" role="alert">请修正以下设置后再应用：
        {settingDefinitions.filter(definition => fieldErrors[definition.key]).map(definition => <button key={definition.key} className="plain-button"
          onClick={() => {
            setQuery(''); setGroup(definition.group);
            requestAnimationFrame(() => document.getElementById(`setting-label-${definition.key}`)?.focus());
          }}>{definition.label}</button>)}
      </div>}
      {snapshot.message && <p className="settings-message" role="status">{snapshot.message}</p>}
      <div className="settings-decisions">
        <button className="plain-button" disabled={busy} onClick={cancel}>取消并还原预览</button>
        <button className="primary-button" disabled={busy || snapshot.version === null || error !== null || Object.keys(fieldErrors).length > 0}
          onClick={() => void run(() => coordinator.save())}>保存设置</button>
      </div>
    </footer>
  </dialog>;
}

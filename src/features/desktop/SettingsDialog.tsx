import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { JsonValue, RawSettings } from '../../shared/contracts/settings';
import { defaultSettings, mergeSettings, parseSettingsImport, settingDefinitions, settingsChanges,
  type SettingDefinition, type SettingGroup, type Settings, type SettingSource } from './settings-schema';
import type { SettingsCoordinator } from './settings';

const sourceNames: Record<SettingSource, string> = { default: '内置默认', user: '用户设置', workspace: '工作区设置', session: '本次预览 / 会话' };
const display = (value: JsonValue | undefined) => value === undefined ? '恢复上层值' : JSON.stringify(value).slice(0, 160);
const settingGroups = [['all', '全部'], ['appearance', '外观'], ['editor', '编辑器'], ['privacy', '隐私']] as const;

function SettingField({ definition, value, onChange }: {
  definition: SettingDefinition; value: Settings[keyof Settings]; onChange: (value: Settings[keyof Settings]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current && input.current.value !== String(value)) input.current.value = String(value); }, [value]);
  const id = `setting-label-${definition.key}`;
  if (definition.kind === 'boolean') return <input id={id} type="checkbox" aria-label={definition.label}
    checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />;
  if (definition.kind === 'theme') return <select id={id} aria-label={definition.label} value={String(value)}
    onChange={event => onChange(event.currentTarget.value as Settings['theme'])}>
    <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
  </select>;
  if (definition.kind === 'tab') return <select id={id} aria-label={definition.label} value={String(value)}
    onChange={event => onChange(Number(event.currentTarget.value))}>
    <option value="2">2 列</option><option value="4">4 列</option><option value="8">8 列</option>
  </select>;
  if (definition.kind === 'whitespace') return <select id={id} aria-label={definition.label} value={String(value)}
    onChange={event => onChange(event.currentTarget.value as Settings['whitespaceMode'])}>
    <option value="none">关闭</option><option value="current">仅当前行</option><option value="all">全部可见</option>
  </select>;
  const numeric = definition.kind === 'number';
  return <input ref={input} id={id} aria-label={definition.label} defaultValue={String(value)} type={numeric ? 'number' : 'text'}
    list={definition.kind === 'font' ? 'local-editor-fonts' : undefined}
    min={numeric ? definition.key === 'fontSize' ? 8 : 1.2 : undefined}
    max={numeric ? definition.key === 'fontSize' ? 40 : 2.5 : undefined}
    step={numeric ? definition.key === 'fontSize' ? 1 : 0.05 : undefined} required maxLength={128}
    onChange={event => onChange(numeric ? Number(event.currentTarget.value) : event.currentTarget.value)} />;
}

export function SettingsDialog({ coordinator, onClose, onShortcuts }: {
  coordinator: SettingsCoordinator; onClose: () => void; onShortcuts: () => void;
}) {
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const categories = useRef<HTMLDivElement>(null);
  const categoryId = useId();
  const search = useRef<HTMLInputElement>(null);
  const importing = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<SettingGroup | 'all'>('all');
  const [horizontal, setHorizontal] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [imported, setImported] = useState<RawSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [restoreId, setRestoreId] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [inputEpoch, setInputEpoch] = useState(0);
  const busy = snapshot.saving || working;
  const userValues = mergeSettings(snapshot.draft ?? snapshot.user).settings;
  const changes = settingsChanges(snapshot.user, snapshot.draft ?? snapshot.user);
  const definitions = settingDefinitions.filter(definition => (group === 'all' || definition.group === group)
    && query.trim().toLocaleLowerCase().split(/\s+/).every(token =>
      `${definition.label} ${definition.key} ${definition.keywords}`.toLocaleLowerCase().includes(token)));
  const fontOptions = useMemo(() => snapshot.fonts?.families.map(name => <option key={name} value={name} />), [snapshot.fonts]);

  useEffect(() => {
    const element = dialog.current;
    coordinator.beginPreview(); element?.showModal(); search.current?.focus();
    return () => element?.close();
  }, [coordinator]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const sync = () => setHorizontal(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  function navigateCategory(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (busy || confirmRestore || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingGroups.length - 1
      : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % settingGroups.length
        : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + settingGroups.length - 1) % settingGroups.length : null;
    const selected = next === null ? undefined : settingGroups[next];
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
            tabIndex={group === id ? 0 : -1} disabled={busy || confirmRestore}
            onKeyDown={event => navigateCategory(event, index)} onClick={() => setGroup(id)}>{label}</button>)}
        </div>
      </nav>
      <div id={`${categoryId}-panel`} className="settings-fields" role="tabpanel" aria-labelledby={`${categoryId}-${group}`} tabIndex={0}>
        <p className="settings-intro">修改会即时预览。保存写入本机配置；取消会还原本次预览。工作区设置和文档临时选择可能覆盖用户值。</p>
        <datalist id="local-editor-fonts">{fontOptions}</datalist>
        <fieldset disabled={busy || confirmRestore}>
          {definitions.map(definition => <div className="settings-row" key={definition.key}>
            <div><label htmlFor={`setting-label-${definition.key}`}>{definition.label}</label>
              <small>默认：{String(defaultSettings[definition.key])} · 当前来源：{sourceNames[snapshot.sources[definition.key]]}</small>
              <small>当前有效：{String(snapshot.settings[definition.key])}</small>
              {definition.description && <small>{definition.description}</small>}</div>
            <SettingField key={`${definition.key}-${inputEpoch}`} definition={definition} value={userValues[definition.key]} onChange={value => {
              const result = coordinator.setPreview(definition.key, value);
              setError(result.ok ? null : result.error.message);
            }} />
            <button className="plain-button" aria-label={`重置${definition.label}`} onClick={() => {
              coordinator.reset([definition.key]); setError(null); setInputEpoch(value => value + 1);
            }}>重置</button>
          </div>)}
          {definitions.length === 0 && <p>没有匹配设置。</p>}
        </fieldset>
        <pre className="settings-font-preview" aria-label="字体预览">轻羽 FeatherPad{`\n`}Aa 0123456789 中文标点，等宽缩进。</pre>
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
        <section className="settings-recovery" aria-label="设置恢复"><h3>配置恢复</h3>
          <p>损坏原件与旧备份会保留。此处列出最多16份已验证旧配置，恢复仍会核对当前版本。</p>
          {snapshot.recoveryCopies.length > 0 ? <>
            <select aria-label="设置旧副本" disabled={busy || confirmRestore} value={restoreId}
              onChange={event => setRestoreId(event.currentTarget.value)}><option value="">选择旧配置</option>
              {snapshot.recoveryCopies.map(copy => <option key={copy.id} value={copy.id}>配置版本 {copy.version} · {copy.id.slice(0, 8)}</option>)}</select>
            <button className="plain-button" disabled={!restoreId || busy} onClick={() => setConfirmRestore(true)}>恢复所选副本…</button>
          </> : <p>当前没有已验证旧副本。</p>}
          {confirmRestore && <div role="group" aria-label="确认恢复设置"><p>将用所选旧配置替换当前设置，当前配置会留有备份。未保存预览会被还原。</p>
            <button autoFocus className="plain-button" disabled={busy} onClick={() => setConfirmRestore(false)}>取消恢复</button>
            <button className="plain-button" disabled={busy} onClick={() => void run(async () => {
              const result = await coordinator.restore(restoreId); if (result.ok) setConfirmRestore(false);
            })}>确认恢复配置</button></div>}
        </section>
      </div>
    </div>
    <footer>
      <div className="settings-tools">
        <button className="plain-button" disabled={busy} onClick={() => { coordinator.cancelPreview(); onShortcuts(); }}>自定义快捷键…</button>
        <input ref={importing} type="file" accept=".json,application/json" aria-label="导入设置文件" hidden
          onChange={event => { void readImport(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
        <button className="plain-button" disabled={busy} onClick={() => importing.current?.click()}>导入…</button>
        <button className="plain-button" disabled={busy} onClick={() => void run(() => coordinator.export())}>导出当前预览…</button>
        <button className="plain-button" disabled={busy} onClick={() => {
          coordinator.reset(settingDefinitions.filter(definition => group === 'all' || definition.group === group).map(definition => definition.key));
          setError(null); setInputEpoch(value => value + 1);
        }}>
          {group === 'all' ? '重置全部已知设置' : '重置本组'}</button>
        <button className="plain-button" disabled={busy} onClick={() => void run(async () => { await coordinator.load(); await coordinator.reloadWorkspace(); })}>重新读取</button>
      </div>
      {(error || snapshot.error) && <p className="settings-message" role="alert">{error ?? snapshot.error}</p>}
      {snapshot.message && <p className="settings-message" role="status">{snapshot.message}</p>}
      <div className="settings-decisions">
        <button className="plain-button" disabled={busy} onClick={cancel}>取消并还原预览</button>
        <button className="plain-button" disabled={busy || confirmRestore} onClick={() => { coordinator.usePreviewForSession(); onClose(); }}>仅本次应用</button>
        <button className="primary-button" disabled={busy || snapshot.version === null || confirmRestore || error !== null}
          onClick={() => void run(() => coordinator.save())}>保存设置</button>
      </div>
    </footer>
  </dialog>;
}

import { useEffect, useId, useRef, useState } from 'react';
import { parsePatternLines, type WorkspaceFilters } from './filters';

function PatternField({ label, value, onApply }: { label: string; value: readonly string[]; onApply: (patterns: string[]) => void }) {
  const id = useId();
  const applied = value.join('\n');
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? applied;
  let error: string | null = null;
  try { parsePatternLines(text); } catch (cause) { error = cause instanceof Error ? cause.message : '过滤规则无效。'; }
  const pending = draft !== null && draft !== applied;
  function apply() {
    if (error || !pending) return;
    onApply(parsePatternLines(text)); setDraft(null);
  }
  return <div className="filter-rule-field"><label htmlFor={`${id}-input`}>{label}</label>
    <textarea id={`${id}-input`} rows={3} aria-label={label.startsWith('包含') ? '包含 glob' : '排除 glob'} value={text}
      aria-invalid={!!error} aria-describedby={id} onChange={event => setDraft(event.currentTarget.value)} onBlur={apply} />
    <small id={id} hidden={!error} role={error ? 'alert' : undefined} className={error ? 'field-error' : undefined}>
      {error ? `${error} 未应用，仍使用原规则。` : ''}
    </small>
    {pending && error && <button type="button" className="plain-button" onClick={() => setDraft(null)}>还原已应用规则</button>}
  </div>;
}

export function FilterRules({ filters, onChange, showHidden, onShowHidden, onClose }: {
  filters: WorkspaceFilters; onChange: (filters: WorkspaceFilters) => void;
  showHidden: boolean; onShowHidden: (value: boolean) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="workspace-filter-rules explorer-filter-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={heading}>文件筛选</h2><button type="button" className="plain-button" onClick={onClose}>完成</button></header>
    <div className="filter-dialog-body">
    <label><input type="checkbox" checked={showHidden} onChange={event => onShowHidden(event.target.checked)} />显示隐藏项</label>
    <label><input type="checkbox" checked={filters.respectGitignore}
      onChange={event => onChange({ ...filters, respectGitignore: event.target.checked })} />遵循 .gitignore 忽略规则</label>
    <label><input type="checkbox" checked={filters.followDirectoryLinks}
      onChange={event => onChange({ ...filters, followDirectoryLinks: event.target.checked })} />跟随文件夹链接</label>
    <PatternField label="包含规则" value={filters.include} onApply={include => onChange({ ...filters, include })} />
    <PatternField label="排除规则" value={filters.exclude} onApply={exclude => onChange({ ...filters, exclude })} />
    </div>
  </dialog>;
}

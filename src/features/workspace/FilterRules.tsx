import { useId, useState } from 'react';
import { defaultIgnoredDirectories, parsePatternLines, type WorkspaceFilters } from './filters';

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
  return <label className="filter-rule-field">{label}
    <textarea aria-label={label.startsWith('包含') ? '包含 glob' : '排除 glob'} value={text}
      aria-invalid={!!error} aria-describedby={id} onChange={event => setDraft(event.currentTarget.value)} onBlur={apply} />
    <small id={id} role={error ? 'alert' : 'status'} className={error ? 'field-error' : undefined}>
      {error ? `${error} 未应用，仍使用原规则。` : pending ? '尚未应用，离开输入框后生效。' : '已应用。最多 256 条，每条不超过 1024 字符。'}
    </small>
    {pending && error && <button type="button" className="plain-button" onClick={() => setDraft(null)}>还原已应用规则</button>}
  </label>;
}

export function FilterRules({ filters, onChange }: { filters: WorkspaceFilters; onChange: (filters: WorkspaceFilters) => void }) {
  return <details className="workspace-filter-rules">
    <summary>搜索与遍历过滤</summary>
    <label><input type="checkbox" checked={filters.respectGitignore}
      onChange={event => onChange({ ...filters, respectGitignore: event.target.checked })} />遵循 .gitignore 忽略规则</label>
    <label><input type="checkbox" checked={filters.followDirectoryLinks}
      onChange={event => onChange({ ...filters, followDirectoryLinks: event.target.checked })} />跟随文件夹链接（自动避免循环）</label>
    <PatternField label="包含文件规则（每行一条）" value={filters.include} onApply={include => onChange({ ...filters, include })} />
    <PatternField label="排除文件规则（每行一条）" value={filters.exclude} onApply={exclude => onChange({ ...filters, exclude })} />
    <small>例如 *.md 匹配 Markdown 文件，docs/** 匹配 docs 文件夹内的内容。</small>
    <small>默认排除 {defaultIgnoredDirectories.join('、')}；包含规则可以指定需要搜索的目录。</small>
  </details>;
}

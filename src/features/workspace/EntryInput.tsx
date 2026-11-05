import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { entryExtension, validateWindowsName } from './file-actions';

interface EntryInputProps {
  depth: number;
  mode: 'create-file' | 'create-directory' | 'rename';
  initialValue?: string;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}

export function EntryInput({
  depth, mode, initialValue = '', onSubmit, onCancel,
}: EntryInputProps) {
  const [name, setName] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = mode === 'rename' ? '重命名'
    : mode === 'create-directory' ? '新建文件夹名称' : '新建文件名称';
  const extension = mode === 'rename' ? entryExtension(initialValue) : null;

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    if (mode === 'rename') {
      const selectionEnd = extension ? initialValue.length - extension.length : initialValue.length;
      element.setSelectionRange(0, selectionEnd);
    } else {
      element.select();
    }
  }, [extension, initialValue, mode]);

  async function submit() {
    if (busy) return;
    const validation = validateWindowsName(name);
    if (validation) {
      setError(validation);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const failure = await onSubmit(name);
      if (failure) {
        setError(failure);
        input.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  return <div className="tree-entry-editor" style={{ '--tree-depth': depth } as CSSProperties}>
    <label>
      <span className="visually-hidden">{label}</span>
      <input
        ref={input}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={name}
        disabled={busy}
        maxLength={255}
        onChange={event => { setName(event.currentTarget.value); setError(null); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </label>
    {extension && <span className="tree-input-hint">后缀 {extension}</span>}
    <div className="tree-input-actions">
      <button type="button" disabled={busy} onClick={() => void submit()}>{busy ? '处理中…' : '确定'}</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
    {error && <p className="tree-input-error" role="alert">{error}</p>}
  </div>;
}

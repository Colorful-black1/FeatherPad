import { useEffect, useRef, useState } from 'react';
import type { LineColumn } from './navigation';

export function GoToLineDialog({ current, onGo, onClose }: {
  current: LineColumn; onGo: (position: LineColumn) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [line, setLine] = useState(String(current.line));
  const [column, setColumn] = useState(String(current.column));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input')?.select();
    return () => element?.close();
  }, []);

  function submit() {
    const nextLine = Number(line);
    const nextColumn = Number(column);
    if (!Number.isFinite(nextLine) || !Number.isFinite(nextColumn)) return;
    onGo({ line: nextLine, column: nextColumn });
    onClose();
  }

  return <dialog ref={dialog} className="goto-dialog" aria-labelledby="goto-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); submit(); }}>
      <header><h2 id="goto-title">跳转到行列</h2></header>
      <div className="goto-fields">
        <label>行 <input aria-label="目标行" inputMode="numeric" value={line}
          onChange={event => setLine(event.currentTarget.value)} /></label>
        <label>列 <input aria-label="目标列" inputMode="numeric" value={column}
          onChange={event => setColumn(event.currentTarget.value)} /></label>
        <p>位置会限制在当前文档范围内，不会插入填充字符。</p>
      </div>
      <footer>
        <button type="button" className="plain-button" onClick={onClose}>取消</button>
        <button type="submit" className="primary-button">跳转</button>
      </footer>
    </form>
  </dialog>;
}

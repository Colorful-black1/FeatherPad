import { useEffect, useRef, useState } from 'react';
import type { HotExitSnapshot } from './hot-exit';

interface HotExitDialogProps {
  snapshot: HotExitSnapshot;
  onRetry: () => Promise<void>;
  onSaveAs: () => Promise<string | null>;
  onDiscard: () => Promise<void>;
  onStay: () => void;
}

export function HotExitDialog({ snapshot, onRetry, onSaveAs, onDiscard, onStay }: HotExitDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    stay.current?.focus();
    return () => element.close();
  }, []);

  const working = busy || snapshot.phase === 'preparing';
  const error = actionError ?? snapshot.error;

  async function run(action: () => Promise<string | null>) {
    if (working) return;
    setBusy(true);
    setActionError(null);
    try {
      const failure = await action();
      if (failure) setActionError(failure);
    } catch {
      setActionError('退出操作未确认；应用保持打开，当前正文仍在内存中。');
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="trash-dialog close-dialog" aria-labelledby="hot-exit-title"
    aria-describedby="hot-exit-description" onCancel={event => {
      event.preventDefault();
      if (!working) onStay();
    }}>
    <header><h2 id="hot-exit-title">{working ? '正在安全退出' : '无法完成安全退出'}</h2></header>
    <div className="trash-body" aria-busy={working}>
      <p id="hot-exit-description">{working
        ? '正在冻结编辑、写入最新恢复副本并保存会话状态。完成前不会关闭窗口。'
        : '部分未保存内容尚未获得可确认的落盘保护。应用保持打开，正文仍在内存中。'}</p>
      {snapshot.failedDocumentIds.length > 0 && <p className="trash-hint">
        受影响文档：{snapshot.failedDocumentIds.length} 个。可以重试、全部另存为新文件，或明确放弃这些修改并退出。
      </p>}
      {!working && <p className="trash-hint">“放弃并退出”会为当前版本写入不可变放弃标记并清理会话；重启后不会复活。</p>}
      {error && <p className="trash-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button ref={stay} type="button" className="plain-button" disabled={working}
        onClick={onStay}>返回编辑器</button>
      <button type="button" className="plain-button" disabled={working}
        onClick={() => void run(async () => {
          const failure = await onSaveAs();
          if (failure) return failure;
          await onRetry();
          return null;
        })}>全部另存后退出</button>
      <button type="button" className="plain-button trash-primary" disabled={working}
        onClick={() => void run(async () => {
          await onDiscard();
          return null;
        })}>放弃全部修改并退出</button>
      <button type="button" className="primary-button" disabled={working}
        onClick={() => void run(async () => {
          await onRetry();
          return null;
        })}>重试安全退出</button>
    </footer>
  </dialog>;
}

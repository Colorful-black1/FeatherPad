import { useEffect, useRef } from 'react';

export type NoticeTone = 'success' | 'info' | 'warning' | 'error';
const labels: Record<NoticeTone, string> = { success: '成功', info: '信息', warning: '注意', error: '错误' };
const icons: Record<NoticeTone, string> = { success: '✓', info: 'ℹ', warning: '⚠', error: '!' };

export function NoticeBanner({ message, tone, onClose }: { message: string; tone: NoticeTone; onClose: () => void }) {
  return <div className="notice error-notice" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}
    aria-live={tone === 'error' ? undefined : 'polite'}>
    <span><strong><span aria-hidden="true">{icons[tone]} </span>{labels[tone]}：</strong><span>{message}</span></span>
    <button type="button" onClick={onClose}>关闭提示</button>
  </div>;
}

/** Blocking feedback for an action the user just attempted. */
export function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (origin.current?.isConnected) origin.current.focus();
    };
  }, []);
  return <dialog ref={dialog} className="notice-dialog" aria-label="操作未完成"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="notice error-notice" data-tone="error" role="alert">
      <span><strong><span aria-hidden="true">! </span>错误：</strong><span>{message}</span></span>
      <button type="button" onClick={onClose}>关闭提示</button>
    </div>
  </dialog>;
}

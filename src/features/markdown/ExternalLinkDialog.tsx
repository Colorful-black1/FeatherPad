import { useEffect, useRef } from 'react';

export function ExternalLinkDialog({ url, busy, onCancel, onConfirm }: {
  url: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="goto-dialog" aria-label="打开外部链接"
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <header><h2>打开外部链接</h2></header>
    <div className="goto-fields"><p>即将把此地址交给系统浏览器或邮件应用：</p>
      <p className="external-link-target">{url}</p><p>预览不会自行访问此地址。</p></div>
    <footer><button type="button" className="plain-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>{busy ? '正在打开…' : '确认打开'}</button></footer>
  </dialog>;
}

import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { Prec, StateEffect } from '@codemirror/state';
import { createEditorState } from './editor-state';

function SnapshotPane({ label, text }: { label: string; text: string }) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!parent.current) return;
    const state = createEditorState(text, true).update({
      effects: StateEffect.appendConfig.of(Prec.highest(EditorView.contentAttributes.of({ 'aria-label': label }))),
    }).state;
    const view = new EditorView({ parent: parent.current, state });
    return () => view.destroy();
  }, [label, text]);
  return <section className="disk-comparison-pane"><h3>{label}</h3><div ref={parent} /></section>;
}

export interface DiskComparisonData { version: number; memory: string; disk: string | null }

export function DiskComparison({ data, busy, error, stale, onCancel, onReload }: {
  data: DiskComparisonData; busy: boolean; error: string | null; stale: boolean;
  onCancel: () => void; onReload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); cancel.current?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className={`trash-dialog ${data.disk === null ? '' : 'disk-comparison'}`}
    aria-labelledby="disk-comparison-title" aria-describedby="disk-comparison-description"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header><h2 id="disk-comparison-title">{data.disk === null ? '重新载入磁盘文件' : '比较当前缓冲与磁盘'}</h2></header>
    <div className="trash-body">
      <p id="disk-comparison-description">重新载入前会保护当前未保存正文，并再次核对磁盘版本。重载将重置此文档的撤销记录。</p>
      {data.disk !== null && <div className="disk-comparison-grid">
        <SnapshotPane label="当前缓冲快照" text={data.memory} />
        <SnapshotPane label="磁盘快照" text={data.disk} />
      </div>}
      {stale && <p className="notice" role="status">当前缓冲已有新变化；请关闭此面板后重新比较或确认。</p>}
      {error && <p className="trash-error" role="alert">{error}</p>}
      {busy && <p role="status">正在保护正文并核对磁盘…</p>}
    </div>
    <footer>
      <button ref={cancel} type="button" className="plain-button" disabled={busy} onClick={onCancel}>保留当前内容</button>
      <button type="button" className="primary-button" disabled={busy || stale} onClick={onReload}>保护草稿并重新载入</button>
    </footer>
  </dialog>;
}

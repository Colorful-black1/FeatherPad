import { useEffect, useMemo, useRef, useState } from 'react';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Prec, StateEffect } from '@codemirror/state';
import { createEditorState } from './editor-state';
import { diffLines, type DiffRange } from './line-diff';
import type { TextFormat } from '../../shared/contracts/files';

export function SnapshotPane({ label, text, ranges, active, format }: {
  label: string; text: string; ranges: readonly DiffRange[]; active: number; format: TextFormat | undefined;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!parent.current) return;
    const initial = createEditorState(text, true);
    const decorate = (view: EditorView) => {
      const positions = new Set<number>();
      for (const visible of view.visibleRanges) {
        let low = 0, high = ranges.length;
        while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid]!.to < visible.from) low = mid + 1; else high = mid; }
        for (let index = low; index < ranges.length && ranges[index]!.from <= visible.to; index++) {
          const range = ranges[index]!;
          const first = view.state.doc.lineAt(Math.max(visible.from, range.from)).number;
          const last = view.state.doc.lineAt(Math.min(visible.to, Math.max(range.from, range.to - 1))).number;
          for (let line = first; line <= last; line++) positions.add(view.state.doc.line(line).from);
        }
      }
      return Decoration.set([...positions].sort((a, b) => a - b).map(position => Decoration.line({ class: 'diff-changed-line' }).range(position)));
    };
    const highlights = ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = decorate(view); }
      update(update: ViewUpdate) { if (update.viewportChanged || update.docChanged) this.decorations = decorate(update.view); }
    }, { decorations: plugin => plugin.decorations });
    const state = initial.update({
      effects: StateEffect.appendConfig.of([Prec.highest(EditorView.contentAttributes.of({ 'aria-label': label })),
        highlights]),
    }).state;
    const view = new EditorView({ parent: parent.current, state });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [label, text, ranges]);
  useEffect(() => {
    const range = ranges[active];
    if (editor.current && range) editor.current.dispatch({
      selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
    });
  }, [active, ranges]);
  return <section className="disk-comparison-pane"><h3>{label}</h3>
    {format && <small>{format.encoding.toUpperCase()} · {format.bom.toUpperCase()} · {format.lineEnding.toUpperCase()}</small>}
    <div ref={parent} /></section>;
}

export interface DiskComparisonData {
  version: number; memory: string; disk: string | null; memoryFormat?: TextFormat; diskFormat?: TextFormat;
}

export function DiskComparison({ data, busy, error, stale, onCancel, onReload }: {
  data: DiskComparisonData; busy: boolean; error: string | null; stale: boolean;
  onCancel: () => void; onReload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const diff = useMemo(() => diffLines(data.memory, data.disk ?? data.memory), [data.memory, data.disk]);
  const memoryRanges = useMemo(() => diff.changes.map(change => change.memory), [diff]);
  const diskRanges = useMemo(() => diff.changes.map(change => change.disk), [diff]);
  const [active, setActive] = useState(0);
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
      {data.disk !== null && <div className="diff-navigation" role="group" aria-label="差异导航">
        <span role="status">{diff.changes.length ? `差异 ${active + 1} / ${diff.changes.length}` : '两份正文一致；格式信息见下方。'}</span>
        <button className="plain-button" disabled={!diff.changes.length} onClick={() => setActive(value =>
          (value + diff.changes.length - 1) % diff.changes.length)}>上一处差异</button>
        <button className="plain-button" disabled={!diff.changes.length} onClick={() => setActive(value =>
          (value + 1) % diff.changes.length)}>下一处差异</button>
        {diff.coarse && <small>较大差异按整块显示，未省略正文；未计算最小逐行差异。</small>}
      </div>}
      {data.disk !== null && <div className="disk-comparison-grid">
        <SnapshotPane label="当前缓冲快照" text={data.memory} ranges={memoryRanges} active={active} format={data.memoryFormat} />
        <SnapshotPane label="磁盘快照" text={data.disk} ranges={diskRanges} active={active} format={data.diskFormat} />
      </div>}
      {stale && <p className="notice" role="status">缓冲或磁盘版本已有新变化；请关闭此面板后重新比较或确认。</p>}
      {error && <p className="trash-error" role="alert">{error}</p>}
      {busy && <p role="status">正在保护正文并核对磁盘…</p>}
    </div>
    <footer>
      <button ref={cancel} type="button" className="plain-button" disabled={busy} onClick={onCancel}>保留当前内容</button>
      <button type="button" className="primary-button" disabled={busy || stale} onClick={onReload}>保护草稿并重新载入</button>
    </footer>
  </dialog>;
}

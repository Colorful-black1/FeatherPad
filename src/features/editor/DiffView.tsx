import { useEffect, useMemo, useRef, useState } from 'react';
import { comparisonBridge, type ComparisonSnapshot } from '../../bridge/comparison';
import { files } from '../../bridge/files';
import { externalFiles } from '../../bridge/external';
import { encodingIds, type EncodingId } from '../../shared/contracts/encoding';
import type { DocumentId, FileRef, TextFormat } from '../../shared/contracts/files';
import type { DocumentRegistry } from './documents';
import { SnapshotPane } from './DiskComparison';
import type { DiffReply, DiffRequest } from './snapshot-diff';

type SideName = 'left' | 'right';
type Source = { kind: 'buffer'; id: DocumentId } | { kind: 'disk'; ref: FileRef; encoding: EncodingId | null; snapshot: ComparisonSnapshot; at: string } | null;
interface Captured { text: string; label: string; format: TextFormat; at: string; buffer?: { id: DocumentId; version: number } }
interface Comparison { left: Captured; right: Captured; diff: DiffReply }

export function DiffView({ registry, onClose }: { registry: DocumentRegistry; onClose: () => void }) {
  const candidates = registry.getSnapshot().documents.filter(item => !registry.getDocument(item.id)?.fragment);
  const [left, setLeft] = useState<Source>(() => candidates[0] ? { kind: 'buffer', id: registry.getSnapshot().activeId && candidates.some(item => item.id === registry.getSnapshot().activeId)
    ? registry.getSnapshot().activeId! : candidates[0].id } : null);
  const [right, setRight] = useState<Source>(() => candidates.find(item => left?.kind === 'buffer' && item.id !== left.id)
    ? { kind: 'buffer', id: candidates.find(item => left?.kind === 'buffer' && item.id !== left.id)!.id } : null);
  const [encoding, setEncoding] = useState<Record<SideName, EncodingId | null>>({ left: null, right: null });
  const [changed, setChanged] = useState<Record<SideName, boolean>>({ left: false, right: false });
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [ignore, setIgnore] = useState(false), [allowLarge, setAllowLarge] = useState(false);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [watchMessage, setWatchMessage] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), worker = useRef<Worker | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), job = useRef<string | null>(null);
  const alive = useRef(true), selecting = useRef(false);
  const refs = useMemo(() => ({ left: left?.kind === 'disk' ? left.ref : null, right: right?.kind === 'disk' ? right.ref : null }), [left, right]);
  const watchKey = JSON.stringify(refs);
  useEffect(() => {
    alive.current = true; const element = dialog.current; element?.showModal(); element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { alive.current = false; worker.current?.terminate(); clearTimeout(deadline.current); element?.close(); };
  }, []);
  useEffect(() => {
    if (!refs.left && !refs.right) return;
    let disposed = false, watchId: string | null = null, unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await externalFiles.listen(event => {
        if (disposed || event.watchId !== watchId) return;
        const matches = (reference: FileRef | null) => !!reference && (event.overflow || event.entries.some(entry => entry.ref.grantId === reference.grantId && entry.ref.relativePath === reference.relativePath));
        setChanged(previous => ({ left: previous.left || matches(refs.left), right: previous.right || matches(refs.right) }));
      });
      if (disposed) { unlisten(); return; }
      const result = await externalFiles.start([refs.left, refs.right].filter((value): value is FileRef => value !== null));
      if (result.ok) { watchId = result.value.watchId; if (disposed) await externalFiles.stop(watchId); else setWatchMessage(null); }
      else if (!disposed) setWatchMessage('当前快照可比较，但无法监测后续磁盘变化，请显式重新读取。');
    })().catch(() => { if (!disposed) setWatchMessage('当前快照可比较，但无法监测后续磁盘变化，请显式重新读取。'); });
    return () => { disposed = true; unlisten?.(); if (watchId) void externalFiles.stop(watchId); };
  }, [watchKey, refs]);
  function stop() { job.current = null; worker.current?.terminate(); worker.current = null; clearTimeout(deadline.current); setBusy(false); }
  function source(which: SideName, value: Source) {
    stop(); setComparison(null); setMessage(null); setChanged(previous => ({ ...previous, [which]: false }));
    if (which === 'left') setLeft(value); else setRight(value);
  }
  async function read(which: SideName, selected?: FileRef) {
    if (selecting.current) return;
    selecting.current = true; setReading(true); setMessage(null); stop();
    try {
      let ref = selected;
      if (!ref) {
        const chosen = await files.chooseFiles(false); if (!alive.current) return;
        if (!chosen.ok) { setMessage(chosen.error.message); return; }
        ref = chosen.value.grants[0];
        if (!ref) { if (chosen.value.failures[0]) setMessage(chosen.value.failures[0].error.message); return; }
      }
      const result = await comparisonBridge.read(ref, encoding[which]); if (!alive.current) return;
      if (!result.ok) setMessage(result.error.message);
      else source(which, { kind: 'disk', ref, encoding: encoding[which], snapshot: result.value, at: new Date().toLocaleString() });
    } finally { selecting.current = false; if (alive.current) setReading(false); }
  }
  function capture(value: Source, side: SideName): Captured {
    if (!value) throw new Error('请选择两侧比较来源。');
    if (value.kind === 'disk') {
      if (value.encoding !== encoding[side]) throw new Error('磁盘编码选择已变化，请重新读取该侧文件。');
      return { text: value.snapshot.text, label: `${value.snapshot.metadata.displayPath}（磁盘 · ${value.snapshot.metadata.diskRevision.slice(0, 8)}）`, format: value.snapshot.format, at: value.at };
    }
    const document = registry.getDocument(value.id);
    if (!document || document.fragment) throw new Error('文档已关闭或不是完整文本，请重新选择。');
    return { text: document.state.doc.toString(), label: `${document.summary.displayPath ?? document.summary.title}（${document.summary.dirty ? '未保存缓冲' : '缓冲'} · v${document.summary.version}）`,
      format: { ...document.summary.format }, at: new Date().toLocaleString(), buffer: { id: value.id, version: document.summary.version } };
  }
  function run() {
    stop(); setMessage(null); setComparison(null);
    try {
      const a = capture(left, 'left'), b = capture(right, 'right');
      const bytes = Math.max(new TextEncoder().encode(a.text).byteLength, new TextEncoder().encode(b.text).byteLength);
      if (bytes >= 20 * 1024 * 1024) throw new Error('20MiB以上内容不提供完整比较，请缩小范围。');
      if (bytes > 2 * 1024 * 1024 && !allowLarge) throw new Error('快照超过2MiB，请勾选本次大文档行diff后再生成。');
      const request: DiffRequest = { requestId: crypto.randomUUID(), left: a.text, right: b.text, ignoreWhitespace: ignore };
      job.current = request.requestId; setBusy(true);
      worker.current = new Worker(new URL('../../workers/diff.worker.ts', import.meta.url), { type: 'module' });
      deadline.current = setTimeout(() => { stop(); setMessage('比较超过2秒预算，已停止；原内容保留。'); }, 2000);
      worker.current.onerror = () => { stop(); setMessage('无法生成比较，请缩小内容后重试。'); };
      worker.current.onmessage = (event: MessageEvent<DiffReply>) => {
        if (event.data.requestId !== job.current) return;
        stop(); setActive(0); setComparison({ left: a, right: b, diff: event.data });
      };
      worker.current.postMessage(request);
    } catch (error: unknown) { stop(); setMessage(error instanceof Error ? error.message : '无法读取比较来源。'); }
  }
  const ranges = useMemo(() => ({ left: comparison?.diff.changes.map(change => change.memory) ?? [], right: comparison?.diff.changes.map(change => change.disk) ?? [] }), [comparison]);
  const stale = !!comparison && [comparison.left, comparison.right].some(side => side.buffer && registry.getDocument(side.buffer.id)?.summary.version !== side.buffer.version);
  const count = comparison?.diff.changes.length ?? 0;
  function selectSide(which: SideName, value: string) { if (value !== 'disk') source(which, value ? { kind: 'buffer', id: value as DocumentId } : null); }
  return <dialog ref={dialog} className="trash-dialog disk-comparison" aria-label="双文件对比" onCancel={event => { event.preventDefault(); stop(); onClose(); }}>
    <header><h2>双文件对比 · 只读快照</h2></header>
    <div className="trash-body"><p>选择打开缓冲或磁盘文件；不会合并、保存或替换任何源文档。</p>
      <fieldset className="diff-source-options" disabled={busy || reading}><legend>比较来源</legend>
        {(['left', 'right'] as const).map(which => {
          const value = which === 'left' ? left : right, label = which === 'left' ? '左侧' : '右侧';
          return <section key={which}><label>{label} <select aria-label={`${label}比较来源`} value={value?.kind === 'buffer' ? value.id : value?.kind === 'disk' ? 'disk' : ''} onChange={event => selectSide(which, event.currentTarget.value)}>
            <option value="">请选择</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.displayPath ?? candidate.title}{candidate.dirty ? '（未保存）' : ''}</option>)}
            {value?.kind === 'disk' && <option value="disk">{value.snapshot.metadata.displayPath}（磁盘）</option>}</select></label>
            <label>磁盘编码 <select aria-label={`${label}磁盘比较编码`} value={encoding[which] ?? 'auto'} onChange={event => {
              const value = event.currentTarget.value === 'auto' ? null : event.currentTarget.value as EncodingId;
              setEncoding(previous => ({ ...previous, [which]: value })); setComparison(null);
            }}><option value="auto">自动</option>{encodingIds.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
            <button type="button" className="plain-button" onClick={() => void read(which)}>选择{label}磁盘文件…</button>
            {value?.kind === 'disk' && <button type="button" className="plain-button" onClick={() => void read(which, value.ref)}>重新读取{label}</button>}
            {changed[which] && <p role="status">{label}磁盘已有变化，仍保留读取时的快照，请重新读取。</p>}
          </section>;
        })}
        <label><input type="checkbox" checked={ignore} onChange={event => { setIgnore(event.currentTarget.checked); setComparison(null); }} />忽略空格/Tab（仅比较）</label>
        <label><input type="checkbox" checked={allowLarge} onChange={event => setAllowLarge(event.currentTarget.checked)} />允许本次大文档行diff（超过2MiB）</label>
      </fieldset>
      {watchMessage && <p className="notice" role="status">{watchMessage}</p>}{message && <p className="notice" role="alert">{message}</p>}
      {stale && <p className="notice" role="status">缓冲已有新版本，当前仍显示所列快照，请重新生成。</p>}
      {comparison && <><div className="diff-navigation" role="group" aria-label="双文件差异导航"><span role="status">{count ? `差异 ${active + 1} / ${count}` : '两份快照一致（按当前比较选项）。'}</span>
        <button type="button" className="plain-button" disabled={!count} onClick={() => setActive(value => (value + count - 1) % count)}>上一处差异</button>
        <button type="button" className="plain-button" disabled={!count} onClick={() => setActive(value => (value + 1) % count)}>下一处差异</button>
        {comparison.diff.coarse && <span>大差异按整块显示，未省略原文。</span>}</div>
        <div className="disk-comparison-grid">
          <div><p>快照时间：{comparison.left.at}</p><SnapshotPane label={comparison.left.label} text={comparison.left.text} ranges={ranges.left} active={active} format={comparison.left.format} /></div>
          <div><p>快照时间：{comparison.right.at}</p><SnapshotPane label={comparison.right.label} text={comparison.right.text} ranges={ranges.right} active={active} format={comparison.right.format} /></div>
        </div></>}
    </div>
    <footer><button type="button" className="plain-button" onClick={() => { stop(); onClose(); }}>关闭对比</button>
      {busy ? <button type="button" className="plain-button" onClick={() => { stop(); setMessage('已取消比较，源文档未修改。'); }}>取消计算</button>
        : <button type="button" className="primary-button" disabled={!left || !right || reading} onClick={run}>{reading ? '正在读取…' : '生成对比'}</button>}</footer>
  </dialog>;
}

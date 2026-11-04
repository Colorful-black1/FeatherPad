import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import type { SettingsDialog as SettingsView } from '../features/desktop/SettingsDialog';
import type { FormatDialog as FormatView } from '../features/search-tools/FormatDialog';
import type { TransformPreview as TransformView } from '../features/search-tools/TransformPreview';
import type { DiffView as ComparisonView } from '../features/editor/DiffView';

const loadSettings = () => import('../features/desktop/SettingsDialog').then(module => module.SettingsDialog);
const loadFormat = () => import('../features/search-tools/FormatDialog').then(module => module.FormatDialog);
const loadTransform = () => import('../features/search-tools/TransformPreview').then(module => module.TransformPreview);
const loadComparison = () => import('../features/editor/DiffView').then(module => module.DiffView);

function DeferredDialog<P extends { onClose: () => void }>({ load, props }: {
  load: () => Promise<ComponentType<P>>; props: P;
}) {
  const [loaded, setLoaded] = useState<{ View: ComponentType<P> } | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const pending = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let disposed = false;
    void load().then(View => { if (!disposed) setLoaded({ View }); }, () => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [load, attempt]);
  useEffect(() => {
    const dialog = pending.current;
    if (!loaded) dialog?.showModal();
    return () => dialog?.close();
  }, [loaded]);
  if (loaded) return <loaded.View {...props} />;
  return <dialog ref={pending} className="deferred-dialog" aria-label="加载对话框" onCancel={event => { event.preventDefault(); props.onClose(); }}>
    <p role={failed ? 'alert' : 'status'}>{failed ? '对话框加载失败，当前文档仍保留。' : '正在打开对话框…'}</p>
    {failed && <button type="button" className="plain-button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试</button>}
    <button type="button" className="plain-button" autoFocus onClick={props.onClose}>关闭</button>
  </dialog>;
}

export function SettingsDialog(props: ComponentProps<typeof SettingsView>) { return <DeferredDialog load={loadSettings} props={props} />; }
export function FormatDialog(props: ComponentProps<typeof FormatView>) { return <DeferredDialog load={loadFormat} props={props} />; }
export function TransformPreview(props: ComponentProps<typeof TransformView>) { return <DeferredDialog load={loadTransform} props={props} />; }
export function DiffView(props: ComponentProps<typeof ComparisonView>) { return <DeferredDialog load={loadComparison} props={props} />; }

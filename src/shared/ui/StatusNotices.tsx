import { Children, useEffect, useRef, type ReactNode } from 'react';

export function StatusNotices({ children }: { children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && details.current && !details.current.contains(event.target)) {
        details.current.open = false;
      }
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const count = Children.count(children);
  return <details ref={details} className="status-notices" onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
  }}>
    <summary title="查看消息" aria-label={`查看消息，共 ${count} 条`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
      <span className="notice-count" aria-hidden="true">{count}</span>
    </summary>
    <div className="status-notice-panel" role="region" aria-label="提示消息">{children}</div>
  </details>;
}

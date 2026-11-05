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

import { safePreviewUrl } from './links';

export function ResourcePanel({ busy, failures, labels, onChooseDirectory, onOpenUrl }: {
  busy: boolean; failures: readonly { index: number; reason: string }[];
  labels: readonly { alt: string; url: string }[]; onChooseDirectory: () => void; onOpenUrl: (url: string) => void;
}) {
  return <div className="markdown-resource-panel">
    {busy && <p className="notice" role="status">正在检查本地图片…</p>}
    {failures.length > 0 && <details className="markdown-resource-details">
      <summary>{failures.length}张图片保留占位</summary>
      <ul>{failures.slice(0, 100).map(failure => <li key={failure.index}>
        <strong>{labels[failure.index]?.alt || `图片 ${failure.index + 1}`}：</strong>{failure.reason}
        {safePreviewUrl(labels[failure.index]?.url ?? '', 'link').kind === 'external'
          && <button type="button" className="plain-button" onClick={() => onOpenUrl(labels[failure.index]!.url)}>查看原链接…</button>}
      </li>)}</ul>{failures.length > 100 && <p>仅展示前100项；其余图片继续保留占位。</p>}
    </details>}
    {failures.length > 0 && <button type="button" className="plain-button" onClick={onChooseDirectory}>
      授权或选择资源目录…</button>}
  </div>;
}

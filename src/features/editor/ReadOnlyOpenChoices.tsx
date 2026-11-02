import type { ReadOnlyOpenCandidate } from './read-only-open';

export function ReadOnlyOpenChoices({ candidates, busy, onOpen, onCancel }: {
  candidates: readonly ReadOnlyOpenCandidate[];
  busy: boolean;
  onOpen: (candidate: ReadOnlyOpenCandidate) => void;
  onCancel: (mode: ReadOnlyOpenCandidate['mode']) => void;
}) {
  return <>{(['head-preview', 'text-preview'] as const).map(mode => {
    const choices = candidates.filter(candidate => candidate.mode === mode);
    if (!choices.length) return null;
    return <div key={mode} className="notice preview-choice" aria-live="polite">
      <span>{mode === 'head-preview' ? '超过100MiB的文件不会自动加载完整内容。请选择是否只读预览前1MiB。'
        : '所选文件可能是二进制或无法无损解码。可只读试开：小于20MiB完整显示，较大文件仅显示前1MiB；无法解释的字节显示为替代字符。'}</span>
      <span className="preview-choice-actions">
        {choices.map((candidate, index) => <button key={`${candidate.ref.grantId}:${candidate.ref.relativePath}`}
          className="plain-button" disabled={busy} onClick={() => onOpen(candidate)}>
          {mode === 'head-preview' ? `预览所选文件 ${index + 1} 的前1MiB` : `只读试开所选文件 ${index + 1}`}
        </button>)}
        <button className="plain-button" disabled={busy} onClick={() => onCancel(mode)}>
          {mode === 'head-preview' ? '取消预览' : '取消只读试开'}
        </button>
      </span>
    </div>;
  })}</>;
}

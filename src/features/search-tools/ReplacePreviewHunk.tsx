import { useMemo } from 'react';
import type { ReplacePreviewHunk } from '../../bridge/replacement';
import { changedLineIndexes, lineRangeLabel } from './replace-preview';

function PreviewPane({
  title, fileName, startLine, lines, highlight, tone,
}: {
  title: string;
  fileName: string;
  startLine: number;
  lines: readonly string[];
  highlight: ReadonlySet<number>;
  tone: 'before' | 'after';
}) {
  return <section className="replace-pane" data-tone={tone}
    aria-label={`${fileName} ${title}，${lineRangeLabel(startLine, lines.length)}`}>
    <header className="replace-pane-head">
      <strong>{title}</strong>
      <span>{lineRangeLabel(startLine, lines.length)}</span>
    </header>
    <div className="replace-code" tabIndex={0}>
      {lines.map((text, index) => <div className="replace-line" key={index}
        data-changed={highlight.has(index) || undefined}>
        <span className="replace-line-number" aria-hidden="true">{startLine + index}</span>
        <code>{text.length > 0 ? text : '\u00a0'}</code>
      </div>)}
    </div>
  </section>;
}

export function ReplacePreviewHunkView({ hunk, fileName, index, count }: {
  hunk: ReplacePreviewHunk;
  fileName: string;
  index: number;
  count: number;
}) {
  const changes = useMemo(() => changedLineIndexes(hunk.before, hunk.after), [hunk]);
  const beforeHighlight = useMemo(() => {
    const highlight = new Set(changes.before);
    for (const line of hunk.matchLines) {
      const index = line - hunk.startLine;
      if (index >= 0 && index < hunk.before.length) highlight.add(index);
    }
    return highlight;
  }, [changes, hunk]);

  return <article className="replace-hunk"
    aria-label={`${fileName} 第 ${hunk.startLine} 行变更 ${index + 1} / ${count}`}>
    <div className="replace-hunk-head">
      <span>变更 {index + 1} / {count}</span>
      <span>{lineRangeLabel(hunk.startLine, hunk.before.length)}</span>
    </div>
    <div className="replace-hunk-panes">
      <PreviewPane title="替换前" fileName={fileName} startLine={hunk.startLine}
        lines={hunk.before} highlight={beforeHighlight} tone="before" />
      <PreviewPane title="替换后" fileName={fileName} startLine={hunk.afterStartLine}
        lines={hunk.after} highlight={changes.after} tone="after" />
    </div>
  </article>;
}

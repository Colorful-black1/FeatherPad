import type { ReactNode } from 'react';
import { breadcrumbSegments } from './navigation';

export function Breadcrumbs({ displayPath, language, children }: {
  displayPath: string | null; language: string; children?: ReactNode;
}) {
  const segments = breadcrumbSegments(displayPath);
  return <nav className="breadcrumbs" aria-label="当前位置">
    <span className="breadcrumb-root">{displayPath ? '工作区文件' : '未命名文档'}</span>
    {segments.map((segment, index) => <span className="breadcrumb-segment" key={`${segment.path}-${index}`}>
      <span aria-hidden="true">/</span><span title={segment.path}>{segment.label}</span>
    </span>)}
    <span className="breadcrumb-language">{language}</span>
    {children}
  </nav>;
}

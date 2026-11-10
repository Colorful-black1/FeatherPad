import type { DirectoryEntry } from '../../shared/contracts/files';
import { describeFileIcon, type IconColor, type IconShape } from './file-icons';

function Glyph({ shape }: { shape: IconShape }) {
  switch (shape) {
    case 'folder':
      return <path d="M3 7V5h7l2 2h9v13H3ZM3 9h18" />;
    case 'folder-open':
      return <path d="M3 8V5h7l2 2h9v2M3 8h18l-2 11H5Z" />;
    case 'link':
      return <path d="M9 7H6a4 4 0 0 0 0 8h3M15 17h3a4 4 0 0 0 0-8h-3M8 12h8" />;
    case 'markdown':
      return <path d="M4.5 17V8l3.5 4 3.5-4v9M15.5 8v8m0 0 3-3m-3 3-3-3" />;
    case 'text':
      return <>
        <path d="M6 3h8l4 4v14H6ZM14 3v5h5" />
        <path d="M9 12h6M9 15h6M9 18h4" />
      </>;
    case 'braces':
      return <path d="M9.5 4.5C7.5 4.5 7 5.6 7 7.5v2C7 11 6.3 12 4.5 12c1.8 0 2.5 1 2.5 2.5v2c0 1.9.5 3 2.5 3M14.5 4.5c2 0 2.5 1.1 2.5 3v2c0 1.5.7 2.5 2.5 2.5-1.8 0-2.5 1-2.5 2.5v2c0 1.9-.5 3-2.5 3" />;
    case 'code':
      return <path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />;
    case 'html':
      return <>
        <path d="M6 3h8l4 4v14H6ZM14 3v5h5" />
        <path d="M9.5 12 8 14l1.5 2M14.5 12l1.5 2-1.5 2M12.8 11.2l-1.6 5.6" />
      </>;
    case 'hash':
      return <path d="M9 4 7.5 20M16.5 4 15 20M5 9h15M4 15h15" />;
    case 'database':
      return <>
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
      </>;
    case 'terminal':
      return <>
        <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
        <path d="M7 9l3 3-3 3M12.5 15H17" />
      </>;
    case 'gear':
      return <>
        <path d="M12 3.5l2.2 1.7 2.7-.4 1.4 2.4-1 2.6L19 12l-1.7 2.2 1 2.6-1.4 2.4-2.7-.4L12 20.5l-2.2-1.7-2.7.4-1.4-2.4 1-2.6L5 12l1.7-2.2-1-2.6 1.4-2.4 2.7.4Z" />
        <circle cx="12" cy="12" r="3" />
      </>;
    case 'image':
      return <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
        <circle cx="8.7" cy="9.2" r="1.6" />
        <path d="M4.5 17l4.5-5 3 3.2 2.2-2.4 4.8 4.2" />
      </>;
    case 'pdf':
      return <>
        <path d="M6 3h8l4 4v14H6ZM14 3v5h5" />
        <path d="M8.5 13h7M8.5 16h7M8.5 19h4" />
      </>;
    case 'word':
      return <>
        <path d="M6 3h8l4 4v14H6ZM14 3v5h5" />
        <path d="M8 12.5l1.3 4 1.6-3 1.6 3 1.3-4" />
      </>;
    case 'sheet':
      return <>
        <rect x="4" y="4.5" width="16" height="15" rx="1.5" />
        <path d="M4 9.5h16M4 14.5h16M9.3 4.5v15M14.6 4.5v15" />
      </>;
    case 'slides':
      return <>
        <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" />
        <path d="M12 15.5V19M8.5 20h7M10.5 8l4 2.5-4 2.5Z" />
      </>;
    case 'archive':
      return <>
        <path d="M4 4.5h16v4H4ZM5.5 8.5h13V20h-13Z" />
        <path d="M10.5 8.5v2M13.5 8.5v2M10.5 12.5v2M13.5 12.5v2M10.5 16.5h3" />
      </>;
    case 'audio':
      return <>
        <path d="M9.5 18V6.5l9-2V16" />
        <circle cx="6.5" cy="18" r="3" />
        <circle cx="15.5" cy="16" r="3" />
      </>;
    case 'video':
      return <>
        <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
        <path d="M6.5 5v14M17.5 5v14" />
        <path d="M10 9l5 3-5 3Z" fill="currentColor" stroke="none" />
      </>;
    case 'font':
      return <path d="M5 19 10.5 5h3L19 19M7.4 14.5h9.2" />;
    case 'lock':
      return <>
        <rect x="6" y="10.5" width="12" height="9.5" rx="1.5" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      </>;
    case 'git':
      return <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="18" cy="7" r="2" />
        <circle cx="18" cy="17" r="2" />
        <path d="M6 7v5a4 4 0 0 0 4 4h6M18 9v6" />
      </>;
    case 'react':
      return <>
        <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" />
      </>;
    case 'package':
      return <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9" />;
    case 'list':
      return <>
        <circle cx="5.5" cy="7" r="1" fill="currentColor" stroke="none" />
        <circle cx="5.5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="5.5" cy="17" r="1" fill="currentColor" stroke="none" />
        <path d="M9 7h10M9 12h10M9 17h10" />
      </>;
    case 'binary':
      return <>
        <rect x="7" y="7" width="10" height="10" rx="1.5" />
        <path d="M9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
      </>;
  }
}

export function EntryIcon({ entry, expanded = false }: { entry: DirectoryEntry; expanded?: boolean }) {
  let shape: IconShape;
  let color: IconColor;
  if (entry.kind === 'directory') {
    shape = expanded ? 'folder-open' : 'folder';
    color = 'neutral';
  } else if (entry.kind === 'junction' || entry.kind === 'symlink') {
    shape = 'link';
    color = 'neutral';
  } else {
    ({ shape, color } = describeFileIcon(entry.name));
  }
  return <svg className="file-icon" data-shape={shape} data-color={color}
    viewBox="0 0 24 24" aria-hidden="true"><Glyph shape={shape} /></svg>;
}

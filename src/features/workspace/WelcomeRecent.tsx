import { useState } from 'react';
import type { RecentEntry } from './recent';

export function WelcomeRecent({ entries, busy, onOpen, onRepair }: {
  entries: readonly RecentEntry[]; busy: boolean;
  onOpen: (entry: RecentEntry) => Promise<string | null>;
  onRepair: (entry: RecentEntry) => Promise<string | null>;
}) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<{ entry: RecentEntry; message: string } | null>(null);
  async function open(entry: RecentEntry, repair = false) {
    if (working || busy) return;
    setWorking(true); setFailed(null);
    try {
      const message = await (repair ? onRepair(entry) : onOpen(entry));
      if (message) setFailed({ entry, message });
    } finally { setWorking(false); }
  }
  if (entries.length === 0) return null;
  return <section className="welcome-recent" aria-labelledby="welcome-recent-title">
    <h2 id="welcome-recent-title">继续上次编辑</h2>
    <ul>{entries.slice(0, 5).map(entry => <li key={entry.id}>
      <button type="button" disabled={busy || working} title={entry.displayPath} onClick={() => void open(entry)}>
        <span>{entry.title}</span><small>{entry.kind === 'workspace' ? '文件夹 · ' : ''}{entry.displayPath}</small>
      </button>
    </li>)}</ul>
    {failed && <div className="field-error" role="alert"><p>{failed.message}</p>
      <button type="button" className="plain-button" disabled={busy || working} onClick={() => void open(failed.entry, true)}>重新选择 {failed.entry.title}</button>
    </div>}
  </section>;
}

import { useState } from 'react';
import type { SaveTransactionCandidate } from '../../shared/contracts/files';
import type { MissingSessionSource } from './session';

interface RecoveryPanelProps {
  candidates: readonly SaveTransactionCandidate[];
  blocked: boolean;
  onOpen: (receiptId: string) => Promise<string | null>;
  missingSources: readonly MissingSessionSource[];
  onReselect: (kind: MissingSessionSource['kind']) => void;
  onForget: (id: string) => void;
}

export function RecoveryPanel({ candidates, blocked, onOpen, missingSources, onReselect, onForget }: RecoveryPanelProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (candidates.length === 0 && missingSources.length === 0) return null;

  async function open(candidate: SaveTransactionCandidate) {
    if (opening || blocked) return;
    setOpening(candidate.receiptId);
    setMessage(null);
    try {
      const failure = await onOpen(candidate.receiptId);
      setMessage(failure ?? `已打开“${candidate.displayName}”的恢复副本，请核对后另存。`);
    } catch {
      setMessage('恢复副本暂未打开，原恢复记录仍保留；可以重试。');
    } finally { setOpening(null); }
  }

  return <details className="save-all-results recovery-panel">
    <summary>{candidates.length > 0 ? `有 ${candidates.length} 个未确认保存的恢复候选`
      : `有 ${missingSources.length} 个会话项目需要重新选择`}</summary>
    <p className="save-all-scope">选择后打开独立副本，原文件和恢复记录均保留。核对内容后可另存。</p>
    <ol aria-label="保存恢复候选">
      {candidates.map(candidate => <li key={candidate.receiptId}>
        <span>{candidate.displayName}</span>
        <span className="save-all-scope">版本 {candidate.bufferVersion} · {candidate.bodyBytes.toLocaleString()} 字节</span>
        <button type="button" className="plain-button" disabled={blocked || opening !== null}
          onClick={() => void open(candidate)} aria-label={`打开恢复副本：${candidate.displayName}`}>
          {opening === candidate.receiptId ? '正在读取…' : '打开恢复副本'}
        </button>
      </li>)}
    </ol>
    {missingSources.length > 0 && <>
      <p className="save-all-scope">以下项目未能自动恢复。可重新选择，或只移除会话占位；文件和恢复正文均保留。</p>
      <ol aria-label="未能恢复的会话项目">{missingSources.map(source => <li key={source.id}>
        <span>{source.kind === 'workspace' ? '文件夹' : '文件'}：{source.title}</span>
        <button type="button" className="plain-button" disabled={blocked || opening !== null}
          onClick={() => onReselect(source.kind)}>重新选择{source.kind === 'workspace' ? '文件夹' : '文件'}</button>
        <button type="button" className="plain-button" disabled={blocked || opening !== null}
          onClick={() => onForget(source.id)} aria-label={`移除会话占位：${source.title}`}>移除占位</button>
      </li>)}</ol>
    </>}
    {message && <p role="status">{message}</p>}
  </details>;
}

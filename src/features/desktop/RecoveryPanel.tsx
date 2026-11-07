import { useState } from 'react';
import type { DocumentId, RecoveryInventory, SaveTransactionCandidate } from '../../shared/contracts/files';
import type { MissingSessionSource } from './session';

interface ActiveRecovery {
  id: DocumentId;
  title: string;
  version: number;
}

interface RecoveryPanelProps {
  standalone?: boolean;
  candidates: readonly SaveTransactionCandidate[];
  blocked: boolean;
  inventory: RecoveryInventory | null;
  inventoryError: string | null;
  activeRecovery: readonly ActiveRecovery[];
  onOpen: (receiptId: string) => Promise<string | null>;
  onRefresh: () => Promise<string | null>;
  onCleanupInactive: () => Promise<string | null>;
  missingSources: readonly MissingSessionSource[];
  onReselect: (kind: MissingSessionSource['kind']) => void;
  onForget: (id: string) => void;
}

const bytes = (value: number) => value < 1024 ? `${value} 字节`
  : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`;

export function RecoveryPanel({
  candidates, blocked, inventory, inventoryError, activeRecovery, onOpen, onRefresh, onCleanupInactive,
  missingSources, onReselect, onForget, standalone = false,
}: RecoveryPanelProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeIds = new Set(activeRecovery.map(document => document.id));
  const inactive = inventory?.entries.filter(entry => !activeIds.has(entry.documentId)) ?? [];
  const inactiveDocumentCount = new Set(inactive.map(entry => entry.documentId)).size;
  const inactiveBytes = inactive.reduce((sum, entry) => sum + entry.bodyBytes, 0);
  const disabled = blocked || working || opening !== null;

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

  async function run(action: () => Promise<string | null>) {
    if (disabled) return;
    setWorking(true);
    setMessage(null);
    try {
      const failure = await action();
      setMessage(failure);
      if (!failure) setConfirmCleanup(false);
    } finally { setWorking(false); }
  }

  const summary = inventory
    ? `本地恢复与隐私 · ${inventory.entries.length} 个恢复副本 · ${bytes(inventory.storageBytes)}`
    : '本地恢复与隐私 · 正在读取范围';

  const Container = standalone ? 'section' : 'details';
  return <Container className="save-all-results recovery-panel" aria-label="本地恢复记录">
    {standalone ? <p className="recovery-overview">{summary}</p> : <summary>{summary}</summary>}
    <p className="save-all-scope">最近记录、收藏和恢复正文分别保存、分别清理。这里只管理恢复副本与保存事务；没有遥测、账号同步或上传。</p>
    <div className="root-actions">
      <button type="button" className="plain-button" disabled={disabled}
        onClick={() => void run(onRefresh)}>重新扫描本地记录</button>
      <button type="button" className="plain-button" disabled={disabled || !inventory || inactive.length === 0}
        onClick={() => setConfirmCleanup(true)}>清理非活动恢复记录…</button>
    </div>
    {candidates.length > 0 && <section aria-label="保存事务恢复候选">
      <h4>未确认保存的恢复候选（{candidates.length}）</h4>
      <p className="save-all-scope">这些保存事务是独立证据，当前入口不会批量删除。选择后打开独立副本，原文件和事务记录均保留。</p>
      <ol>{candidates.map(candidate => <li key={candidate.receiptId}>
        <span>{candidate.displayName}</span>
        <span className="save-all-scope">版本 {candidate.bufferVersion} · {candidate.bodyBytes.toLocaleString()} 字节</span>
        <button type="button" className="plain-button" disabled={disabled}
          onClick={() => void open(candidate)} aria-label={`打开恢复副本：${candidate.displayName}`}>
          {opening === candidate.receiptId ? '正在读取…' : '打开恢复副本'}
        </button>
      </li>)}</ol>
    </section>}
    {inventoryError && <p role="alert">{inventoryError}</p>}
    {inventory && <>
      <p className="save-all-scope">恢复记录 {inventory.entries.length} 个，正文合计 {bytes(inventory.entries.reduce((sum, entry) => sum + entry.bodyBytes, 0))}；
        恢复目录与保存事务合计 {bytes(inventory.storageBytes)}。</p>
      <section aria-label="受保护的活动未保存副本">
        <h4>活动未保存副本（{activeRecovery.length}）</h4>
        {activeRecovery.length > 0 ? <>
          <p className="save-all-scope">以下文档仍打开且有未保存修改，其全部恢复版本默认受保护。请先保存、关闭并处理未保存修改；此入口不会替你丢弃正文。</p>
          <ul>{activeRecovery.map(document => <li key={document.id}>
            {document.title} · 缓冲版本 {document.version} · 默认保护
          </li>)}</ul>
        </> : <p className="save-all-scope">当前没有需要保护的活动未保存副本。</p>}
      </section>
      {inventory.failures.length > 0 && <section aria-label="损坏或无法读取的恢复记录">
        <h4>保留的异常记录（{inventory.failures.length}）</h4>
        <p className="save-all-scope">损坏、歧义或无法读取的条目不会被自动删除，请修复后重新扫描。</p>
        <ul>{inventory.failures.map(failure => <li key={failure.entryId}>{failure.message}</li>)}</ul>
      </section>}
      {inventory.startupWarnings.length > 0 && <ul>{inventory.startupWarnings.map(warning =>
        <li key={warning}>{warning}</li>)}</ul>}
    </>}
    {confirmCleanup && <section className="recent-confirm" role="group" aria-label="确认清理非活动恢复记录">
      <p>将清理 {inventory?.entries.length ?? 0} 个恢复副本中不属于当前活动未保存文档的部分，共 {inactive.length} 个条目、
        {bytes(inactiveBytes)}。活动未保存副本和无法识别的记录会保留；此操作不能恢复已清理的恢复正文。</p>
      <button type="button" autoFocus className="plain-button" disabled={disabled}
        onClick={() => setConfirmCleanup(false)}>取消清理</button>
      <button type="button" className="plain-button" disabled={disabled}
        onClick={() => void run(onCleanupInactive)}>确认清理 {inactiveDocumentCount} 个非活动文档的记录</button>
    </section>}
    {missingSources.length > 0 && <section aria-label="未能自动恢复的会话项目">
      <h4>需要重新选择的会话项目（{missingSources.length}）</h4>
      <p className="save-all-scope">以下项目未能自动恢复。可重新选择，或只移除会话占位；文件和恢复正文均保留。</p>
      <ol>{missingSources.map(source => <li key={source.id}>
        <span>{source.kind === 'workspace' ? '文件夹' : '文件'}：{source.title}</span>
        <button type="button" className="plain-button" disabled={disabled}
          onClick={() => onReselect(source.kind)}>重新选择{source.kind === 'workspace' ? '文件夹' : '文件'}</button>
        <button type="button" className="plain-button" disabled={disabled}
          onClick={() => onForget(source.id)} aria-label={`移除会话占位：${source.title}`}>移除占位</button>
      </li>)}</ol>
    </section>}
    {message && <p role="status">{message}</p>}
  </Container>;
}

import type { AppError, DocumentId } from '../../shared/contracts/files';
import { documents, type DocumentRegistry } from './documents';
import { saves, type SaveCoordinator } from './save';

type SaveAllOutcome =
  | { status: 'pending' | 'saving' | 'unchanged' | 'cancelled' | 'unprocessed' }
  | { status: 'saved'; version: number }
  | { status: 'failed'; error: AppError };
export type SaveAllItem = { id: DocumentId; title: string } & SaveAllOutcome;
interface SaveAllSnapshot {
  phase: 'idle' | 'running' | 'cancelling' | 'finished';
  items: readonly SaveAllItem[];
}

export class SaveAllCoordinator {
  private snapshot: SaveAllSnapshot = { phase: 'idle', items: [] };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly registry: DocumentRegistry, private readonly saver: Pick<SaveCoordinator, 'save'>) {}

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  cancel() {
    if (this.snapshot.phase === 'running') this.publish({ ...this.snapshot, phase: 'cancelling' });
  }

  dismiss() {
    if (this.snapshot.phase === 'finished') this.publish({ phase: 'idle', items: [] });
  }

  async run(): Promise<void> {
    if (this.snapshot.phase === 'running' || this.snapshot.phase === 'cancelling') return;
    const items: SaveAllItem[] = this.registry.getSnapshot().documents
      .filter(document => document.dirty).map(document => ({ id: document.id, title: document.title, status: 'pending' }));
    this.publish({ phase: 'running', items });
    for (let index = 0; index < items.length; index++) {
      if (this.getSnapshot().phase === 'cancelling') break;
      const item = items[index]!;
      if (this.registry.getDocument(item.id)?.summary.dirty === false) {
        this.update(index, { status: 'unchanged' });
        continue;
      }
      this.update(index, { status: 'saving' });
      try {
        const result = await this.saver.save(item.id);
        if (result.ok) this.update(index, { status: 'saved', version: result.value.documentVersion });
        else if (result.error.code === 'CANCELLED') {
          this.update(index, { status: 'cancelled' });
          this.cancel();
        } else this.update(index, { status: 'failed', error: result.error });
      } catch {
        this.update(index, { status: 'failed', error: { code: 'IPC_UNAVAILABLE',
          message: '保存结果未确认，内容仍保留；请核对后重试。', retryable: false } });
      }
    }
    this.publish({ phase: 'finished', items: this.snapshot.items.map(item =>
      item.status === 'pending' ? { ...item, status: 'unprocessed' } : item) });
  }

  private update(index: number, outcome: SaveAllOutcome) {
    this.publish({ ...this.snapshot, items: this.snapshot.items.map((item, position) =>
      position === index ? { id: item.id, title: item.title, ...outcome } : item) });
  }

  private publish(snapshot: SaveAllSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
}

export const saveAll = new SaveAllCoordinator(documents, saves);

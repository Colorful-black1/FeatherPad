import { normalizeShortcut, shortcutForEvent, shortcutRestriction, type ShortcutEvent } from './keyboard';

export interface CommandDefinition<Context, Actions = void> {
  id: string;
  title: string;
  keywords: string;
  defaultBinding: string | null;
  disabledReason: (context: Context) => string | null;
  execute: (context: Context, actions: Actions) => void | Promise<void>;
}
export interface CommandItem {
  id: string;
  title: string;
  keywords: string;
  binding: string | null;
  disabledReason: string | null;
}
export type CommandResult = { ok: true } | { ok: false; reason: string };
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const preferenceKey = 'featherpad.commands.bindings.v1';

function browserStorage(): PreferenceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export class CommandRegistry<Context, Actions = void> {
  private readonly definitions = new Map<string, CommandDefinition<Context, Actions>>();
  private readonly overrides = new Map<string, string | null>();
  private readonly running = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: { revision: number; warning: string | null } = { revision: 0, warning: null };

  constructor(definitions: readonly CommandDefinition<Context, Actions>[], private readonly storage: PreferenceStorage | null = browserStorage()) {
    const bindings = new Set<string>();
    for (const definition of definitions) {
      const binding = definition.defaultBinding;
      if (!/^[a-z][a-zA-Z0-9.]{0,95}$/.test(definition.id) || this.definitions.has(definition.id)) throw new Error('Invalid command identity');
      if (binding && (normalizeShortcut(binding) !== binding || shortcutRestriction(binding) || bindings.has(binding))) throw new Error('Invalid default shortcut');
      if (binding) bindings.add(binding);
      this.definitions.set(definition.id, definition);
    }
    try {
      const raw = storage?.getItem(preferenceKey);
      if (raw) {
        if (raw.length > 65_536 || new TextEncoder().encode(raw).byteLength > 65_536) throw new Error('Large shortcut settings');
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Reflect.get(value, 'schemaVersion') !== 1) throw new Error('Unsupported shortcut settings');
        const entries: unknown = Reflect.get(value, 'bindings');
        if (!Array.isArray(entries) || entries.length > 256) throw new Error('Invalid shortcut settings');
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !this.definitions.has(entry[0])
            || this.overrides.has(entry[0]) || (entry[1] !== null && (typeof entry[1] !== 'string'
              || normalizeShortcut(entry[1]) !== entry[1] || shortcutRestriction(entry[1])))) throw new Error('Invalid shortcut mapping');
          this.overrides.set(entry[0], entry[1]);
        }
        const effective = [...this.definitions.keys()].map(id => this.binding(id)).filter(binding => binding !== null);
        if (new Set(effective).size !== effective.length) throw new Error('Conflicting shortcut settings');
      }
    } catch {
      this.overrides.clear();
      this.snapshot = { revision: 0, warning: '快捷键配置无法读取，已使用默认绑定。' };
    }
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  binding(id: string): string | null {
    return this.overrides.has(id) ? this.overrides.get(id)! : this.definitions.get(id)?.defaultBinding ?? null;
  }

  disabledReason(id: string, context: Context): string | null {
    const definition = this.definitions.get(id);
    return !definition ? '命令不可用。' : this.running.has(id) ? '此命令正在执行。' : definition.disabledReason(context);
  }

  list(context: Context, query = ''): CommandItem[] {
    const tokens = query.slice(0, 256).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...this.definitions.values()].filter(definition => tokens.every(token =>
      `${definition.title} ${definition.keywords} ${definition.id}`.toLocaleLowerCase().includes(token)))
      .map(definition => ({ id: definition.id, title: definition.title, keywords: definition.keywords,
        binding: this.binding(definition.id), disabledReason: this.disabledReason(definition.id, context) }));
  }

  commandForEvent(event: ShortcutEvent): string | null {
    const binding = shortcutForEvent(event);
    if (!binding || shortcutRestriction(binding)) return null;
    return [...this.definitions.keys()].find(id => this.binding(id) === binding) ?? null;
  }

  async execute(id: string, context: Context, actions: Actions): Promise<CommandResult> {
    const reason = this.disabledReason(id, context);
    if (reason) return { ok: false, reason };
    this.running.add(id);
    this.publish(this.snapshot.warning);
    try { await this.definitions.get(id)!.execute(context, actions); return { ok: true }; }
    catch { return { ok: false, reason: '命令未能完成，请保留当前内容并重试。' }; }
    finally { this.running.delete(id); this.publish(this.snapshot.warning); }
  }

  setBinding(id: string, value: string | null): CommandResult {
    if (!this.definitions.has(id)) return { ok: false, reason: '命令不可用。' };
    const binding = value === null ? null : normalizeShortcut(value);
    if (value !== null && binding === null) return { ok: false, reason: '请输入 Ctrl/Alt 组合或 F1–F12，例如 Ctrl+Shift+P。' };
    const restriction = binding ? shortcutRestriction(binding) : null;
    if (restriction) return { ok: false, reason: restriction };
    const conflict = binding && [...this.definitions.values()].find(definition => definition.id !== id && this.binding(definition.id) === binding);
    if (conflict) return { ok: false, reason: `此快捷键已用于“${conflict.title}”，请先解除该绑定。` };
    if (binding === this.definitions.get(id)!.defaultBinding) this.overrides.delete(id);
    else this.overrides.set(id, binding);
    this.persist();
    return { ok: true };
  }

  resetBindings() { this.overrides.clear(); this.persist(); }

  private persist() {
    try {
      const raw = JSON.stringify({ schemaVersion: 1, bindings: [...this.overrides] });
      if (!this.storage || this.overrides.size > 256 || new TextEncoder().encode(raw).byteLength > 65_536) throw new Error('Unavailable shortcut preferences');
      this.storage.setItem(preferenceKey, raw);
      this.publish(null);
    } catch { this.publish('快捷键仅本次生效，配置未能保存。'); }
  }

  private publish(warning: string | null) {
    this.snapshot = { revision: this.snapshot.revision + 1, warning };
    this.listeners.forEach(listener => listener());
  }
}

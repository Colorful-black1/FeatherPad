import { expect, it, vi } from 'vitest';
import { CommandRegistry, type CommandDefinition } from './registry';

interface Context { readOnly: boolean }
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const action = vi.fn(async () => {});
  const definitions: CommandDefinition<Context>[] = [
    { id: 'file.save', title: '保存', keywords: 'save write', defaultBinding: 'Ctrl+S',
      disabledReason: context => context.readOnly ? '当前为只读。' : null, execute: action },
    { id: 'commands.open', title: '命令面板', keywords: 'command palette', defaultBinding: 'Ctrl+Shift+P', disabledReason: () => null, execute: () => {} },
  ];
  const registry = new CommandRegistry(definitions, storage);
  return { values, storage, registry, definitions, action };
}

it('lists disabled reasons and bindings while filtering localized names and multiple keyword tokens', () => {
  const h = fixture();
  expect(h.registry.list({ readOnly: true }, '保存')).toMatchObject([{ id: 'file.save', binding: 'Ctrl+S', disabledReason: '当前为只读。' }]);
  expect(h.registry.list({ readOnly: false }, 'command palette')).toHaveLength(1);
  expect(h.registry.list({ readOnly: false }, 'missing')).toEqual([]);
});

it('rechecks current enablement on every entry and rejects in-flight duplicates without hiding failures', async () => {
  const h = fixture();
  expect(await h.registry.execute('file.save', { readOnly: true }, undefined)).toEqual({ ok: false, reason: '当前为只读。' });
  expect(h.action).not.toHaveBeenCalled();
  let finish!: () => void;
  h.action.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = h.registry.execute('file.save', { readOnly: false }, undefined);
  expect(await h.registry.execute('file.save', { readOnly: false }, undefined)).toMatchObject({ ok: false, reason: '此命令正在执行。' });
  finish();
  expect(await first).toEqual({ ok: true });
  h.action.mockRejectedValueOnce(new Error('must not display private data'));
  expect(await h.registry.execute('file.save', { readOnly: false }, undefined)).toEqual({ ok: false, reason: '命令未能完成，请保留当前内容并重试。' });
  expect(h.registry.disabledReason('file.save', { readOnly: false })).toBeNull();
});

it('rejects remapping conflicts and reserved keys without changing or persisting either binding', () => {
  const h = fixture();
  expect(h.registry.setBinding('file.save', 'Ctrl+Shift+P')).toMatchObject({ ok: false, reason: expect.stringContaining('命令面板') });
  expect(h.registry.setBinding('file.save', 'Ctrl+C')).toMatchObject({ ok: false });
  expect(h.registry.setBinding('file.save', 'Alt+F4')).toMatchObject({ ok: false });
  expect(h.registry.binding('file.save')).toBe('Ctrl+S');
  expect(h.values.size).toBe(0);
});

it('supports unbinding, remapping and reset across restarts without storing actions or body', () => {
  const h = fixture();
  expect(h.registry.setBinding('file.save', 'control+shift+l')).toEqual({ ok: true });
  const next = new CommandRegistry(h.definitions, h.storage);
  expect(next.binding('file.save')).toBe('Ctrl+Shift+L');
  const event = { key: 'l', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false };
  expect(next.commandForEvent(event)).toBe('file.save');
  expect(next.commandForEvent({ ...event, key: 's', shiftKey: false })).toBeNull();
  expect(next.setBinding('commands.open', null)).toEqual({ ok: true });
  next.resetBindings();
  expect(new CommandRegistry(h.definitions, h.storage).binding('commands.open')).toBe('Ctrl+Shift+P');
  expect([...h.values.values()][0]).toBe('{"schemaVersion":1,"bindings":[]}');
});

it('rejects malformed, oversized and conflicting persisted mappings as one configuration', () => {
  const h = fixture();
  for (const raw of ['{broken', 'x'.repeat(65_537), JSON.stringify({ schemaVersion: 1, bindings: [['file.save', 'Ctrl+Shift+P']] }),
    JSON.stringify({ schemaVersion: 1, bindings: [['file.save', 'Ctrl+C']] }),
    JSON.stringify({ schemaVersion: 1, bindings: [['unknown.command', 'Ctrl+K']] })]) {
    h.values.set('featherpad.commands.bindings.v1', raw);
    const next = new CommandRegistry(h.definitions, h.storage);
    expect(next.binding('file.save')).toBe('Ctrl+S');
    expect(next.getSnapshot().warning).toContain('无法读取');
  }
});

it('keeps an in-memory remap and warns when preferences cannot be written', () => {
  const h = fixture();
  h.storage.setItem = () => { throw new Error('private storage failure'); };
  expect(h.registry.setBinding('file.save', 'Ctrl+K')).toEqual({ ok: true });
  expect(h.registry.binding('file.save')).toBe('Ctrl+K');
  expect(h.registry.getSnapshot().warning).toBe('快捷键仅本次生效，配置未能保存。');
});

it('exports and atomically imports the complete canonical binding map', () => {
  const h = fixture();
  h.registry.setBinding('file.save', 'Ctrl+K');
  const exported = h.registry.exportBindings();
  expect(JSON.parse(exported)).toEqual({
    schemaVersion: 1,
    bindings: [['file.save', 'Ctrl+K'], ['commands.open', 'Ctrl+Shift+P']],
  });
  expect(exported).not.toContain('keywords');
  expect(exported).not.toContain('action');

  h.registry.setBinding('commands.open', null);
  const imported = JSON.parse(exported) as { bindings: [string, string | null][] };
  imported.bindings[0]![1] = 'Ctrl+Shift+O';
  imported.bindings[1]![1] = 'Ctrl+Shift+J';
  expect(h.registry.importBindings(JSON.stringify(imported))).toEqual({ ok: true });
  expect(h.registry.bindings()).toEqual({ 'file.save': 'Ctrl+Shift+O', 'commands.open': 'Ctrl+Shift+J' });

  imported.bindings[1]![1] = 'Ctrl+Shift+O';
  expect(h.registry.importBindings(JSON.stringify(imported))).toMatchObject({ ok: false, reason: expect.stringContaining('冲突') });
  expect(h.registry.bindings()).toEqual({ 'file.save': 'Ctrl+Shift+O', 'commands.open': 'Ctrl+Shift+J' });
  expect(h.registry.importBindings(JSON.stringify({ schemaVersion: 1, bindings: [['file.save', 'Ctrl+K']] })))
    .toMatchObject({ ok: false });
  expect(h.registry.bindings()).toEqual({ 'file.save': 'Ctrl+Shift+O', 'commands.open': 'Ctrl+Shift+J' });
});

import { expect, it } from 'vitest';
import { defaultSettings, exportSettings, isRawSettings, isSettingValue, mergeSettings, parseSettingsImport,
  resetSettings, settingsChanges } from './settings-schema';

it('applies default, user, allowed workspace and temporary session precedence', () => {
  const merged = mergeSettings({ fontSize: 18, tabSize: 2, theme: 'dark' },
    { tabSize: 8, insertSpaces: false, theme: 'light', fontSize: 32 }, { tabSize: 4 });
  expect(merged.settings).toMatchObject({ fontSize: 18, theme: 'dark', tabSize: 4, insertSpaces: false });
  expect(merged.sources).toMatchObject({ fontSize: 'user', theme: 'user', tabSize: 'session', insertSpaces: 'workspace', wordWrap: 'default' });
  expect(merged.diagnostics.map(item => item.key)).toEqual(['theme', 'fontSize']);
  expect(defaultSettings.theme).toBe('system');
});

it('invalid values fall back by layer while unknown and invalid fields remain exportable', () => {
  const raw = { fontSize: -4, theme: 'future', tabSize: 2, future: { a: true } };
  const result = mergeSettings(raw, { tabSize: 3 }, { lineHeight: 999 });
  expect(result.settings).toMatchObject({ fontSize: 14, theme: 'system', tabSize: 2, lineHeight: 1.85 });
  expect(result.diagnostics).toHaveLength(5);
  expect(JSON.parse(exportSettings(raw)).settings).toEqual(raw);
  expect(raw).toEqual({ fontSize: -4, theme: 'future', tabSize: 2, future: { a: true } });
});

it('resetting a group preserves unknown configuration and exposes defaults without mutating input', () => {
  const raw = { theme: 'dark', fontSize: 18, tabSize: 8, future: 'retain' };
  const reset = resetSettings(raw, ['theme', 'fontSize']);
  expect(reset).toEqual({ tabSize: 8, future: 'retain' });
  expect(mergeSettings(reset).settings).toMatchObject({ theme: 'system', fontSize: 14, tabSize: 8 });
  expect(raw.theme).toBe('dark');
});

it('imports versioned JSON for preview without applying or executing its fields', () => {
  const raw = { theme: 'dark', future: { command: 'do not execute' }, fontSize: 'invalid' };
  const parsed = parseSettingsImport(JSON.stringify({ schemaVersion: 1, settings: raw }));
  expect(parsed).toEqual({ ok: true, value: raw });
  expect(settingsChanges({ theme: 'light' }, raw).map(item => item.key)).toEqual(['fontSize', 'future', 'theme']);
  expect(parseSettingsImport('{broken')).toMatchObject({ ok: false });
  expect(parseSettingsImport('{"schemaVersion":2,"settings":{}}')).toMatchObject({ ok: false });
  expect(parseSettingsImport('x'.repeat(65_537))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
});

it('rejects prototype pollution, non-JSON objects and unbounded nesting or collections', () => {
  expect(isRawSettings(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
  expect(isRawSettings({ value: new Date() })).toBe(false);
  expect(isRawSettings({ value: Number.NaN })).toBe(false);
  expect(isRawSettings({ value: Array(257).fill(null) })).toBe(false);
  let nested: Record<string, unknown> = {};
  for (let i = 0; i < 18; i++) nested = { child: nested };
  expect(isRawSettings(nested)).toBe(false);
  expect(parseSettingsImport('{"schemaVersion":1,"settings":{"constructor":{}}}')).toMatchObject({ ok: false });
});

it('accepts local font names and finite view ranges while rejecting CSS fragments', () => {
  expect(isSettingValue('fontFamily', '等距更纱黑体 SC')).toBe(true);
  expect(isSettingValue('fontFamily', 'Consolas; color:red')).toBe(false);
  expect(isSettingValue('fontFamily', '"Arial"')).toBe(false);
  expect(isSettingValue('fontSize', 40)).toBe(true);
  expect(isSettingValue('fontSize', 41)).toBe(false);
  expect(isSettingValue('fontSize', 14.5)).toBe(false);
  expect(isSettingValue('lineHeight', 1.85)).toBe(true);
  expect(isSettingValue('lineHeight', Infinity)).toBe(false);
  expect(isSettingValue('globalLaunchShortcut', 'Ctrl+Shift+Space')).toBe(true);
  expect(isSettingValue('globalLaunchShortcut', 'ctrl+shift+space')).toBe(false);
  expect(isSettingValue('globalLaunchShortcut', 'Ctrl+Alt+S')).toBe(false);
  expect(isSettingValue('globalLaunchShortcut', 'Shift+S')).toBe(false);
});

import { expect, it } from 'vitest';
import { normalizeShortcut, shortcutForEvent, shortcutRestriction } from './keyboard';

it('normalizes modifier order and aliases without accepting duplicate or unmodified input keys', () => {
  expect(normalizeShortcut('shift + control + p')).toBe('Ctrl+Shift+P');
  expect(normalizeShortcut('Alt+F4')).toBe('Alt+F4');
  expect(normalizeShortcut('F8')).toBe('F8');
  for (const value of ['P', 'Shift+P', 'Ctrl+Ctrl+P', 'Meta+P', 'Ctrl++P', 'Ctrl+Enter', 'Ctrl+' + 'a'.repeat(65)]) {
    expect(normalizeShortcut(value)).toBeNull();
  }
});

it('protects native edit commands, system combinations and AltGr without reserving app commands', () => {
  for (const value of ['Ctrl+C', 'Ctrl+Shift+Z', 'Ctrl+Shift+K', 'Ctrl+I', 'Alt+F4', 'Alt+Tab', 'Shift+Alt+Tab', 'Ctrl+Alt+S']) expect(shortcutRestriction(value)).toBeTruthy();
  expect(shortcutRestriction('Ctrl+Shift+P')).toBeNull();
});

it('does not dispatch composition, dead keys, Meta or unmodified typing', () => {
  const event = { key: 'p', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false };
  expect(shortcutForEvent(event)).toBe('Ctrl+P');
  expect(shortcutForEvent({ ...event, isComposing: true })).toBeNull();
  expect(shortcutForEvent({ ...event, key: 'Dead' })).toBeNull();
  expect(shortcutForEvent({ ...event, metaKey: true })).toBeNull();
  expect(shortcutForEvent({ ...event, ctrlKey: false })).toBeNull();
});

it('maps plus/equal zoom aliases consistently while keeping malformed modifiers invalid', () => {
  for (const value of ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift+=', 'Ctrl+Shift++']) expect(normalizeShortcut(value)).toBe('Ctrl+=');
  expect(normalizeShortcut('Ctrl+-')).toBe('Ctrl+-');
  expect(shortcutForEvent({ key: '+', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false })).toBe('Ctrl+=');
  for (const value of ['Ctrl+Ctrl++', 'Ctrl++P', '+', 'Shift++']) expect(normalizeShortcut(value)).toBeNull();
});

it('reserves F6 navigation in both directions without reserving unrelated function keys', () => {
  expect(shortcutRestriction('F6')).toContain('区域导航');
  expect(shortcutRestriction('Shift+F6')).toContain('区域导航');
  expect(shortcutRestriction('F8')).toBeNull();
});

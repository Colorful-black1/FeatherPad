import { afterEach, expect, it, vi } from 'vitest';
import { loadSidebarWidth, sidebarDefaultWidth, sidebarMinWidth } from './view-preferences';

afterEach(() => vi.unstubAllGlobals());

it.each([180, 200, 219])('migrates the previously valid %i-pixel width without an error', width => {
  vi.stubGlobal('window', { localStorage: { getItem: () => String(width) } });
  expect(loadSidebarWidth()).toEqual({ value: sidebarMinWidth, warning: null });
});

it.each([220, 280, 400, 640])('preserves the saved %i-pixel preference', width => {
  vi.stubGlobal('window', { localStorage: { getItem: () => String(width) } });
  expect(loadSidebarWidth()).toEqual({ value: width, warning: null });
});

it('uses the new default width when there is no saved preference', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null } });
  expect(loadSidebarWidth()).toEqual({ value: sidebarDefaultWidth, warning: null });
});

it('keeps invalid records visibly separate from valid older widths', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => '179' } });
  expect(loadSidebarWidth().warning).toContain('记录无效');
});

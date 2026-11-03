import { expect, it } from 'vitest';
import { fontSizeAfterZoom } from './view-settings';
import { createAppCommands, type AppCommandState } from '../../app/register-commands';

it('font zoom respects 8–40px bounds and resets to 14px', () => {
  expect(fontSizeAfterZoom(14, 'in')).toBe(15);
  expect(fontSizeAfterZoom(14, 'out')).toBe(13);
  expect(fontSizeAfterZoom(40, 'in')).toBe(40);
  expect(fontSizeAfterZoom(8, 'out')).toBe(8);
  expect(fontSizeAfterZoom(40, 'reset')).toBe(14);
});

it('font commands share the registry, allow read-only views and honor remapping', () => {
  const commands = createAppCommands();
  const state: AppCommandState = { hasDocument: true, readOnlyReason: '只读', canSaveAs: true,
    hasDirty: false, isPreview: false, tabCount: 1, cleanTabCount: 1, isSplit: false, canReopen: false,
    canNavigateBack: false, canNavigateForward: false, hasWorkspace: false,
    opening: false, saving: false, closing: false, batchBusy: false };
  expect(commands.list(state, 'font zoom').map(command => command.disabledReason)).toEqual([null, null, null]);
  expect(commands.list({ ...state, hasDocument: false }, 'font zoom').every(command => command.disabledReason)).toBe(true);
  const event = { key: '+', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false };
  expect(commands.commandForEvent(event)).toBe('editor.fontIncrease');
  expect(commands.setBinding('editor.fontIncrease', 'Ctrl+9')).toMatchObject({ ok: true });
  expect(commands.commandForEvent(event)).toBeNull();
  expect(commands.commandForEvent({ ...event, key: '9', shiftKey: false })).toBe('editor.fontIncrease');
});

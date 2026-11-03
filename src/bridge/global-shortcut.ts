import { callCommand, isRecord } from './invoke';

export interface GlobalShortcutStatus {
  enabled: boolean;
}

const isStatus = (value: unknown): value is GlobalShortcutStatus =>
  isRecord(value) && typeof value.enabled === 'boolean';

export const globalShortcutBridge = {
  configure: (enabled: boolean, shortcut: string) =>
    callCommand('set_global_shortcut', { enabled, shortcut }, isStatus),
};

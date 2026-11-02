export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type RawSettings = Record<string, JsonValue>;
export interface SettingsCopy { id: string; version: number }
export interface LoadedSettings {
  schemaVersion: 1;
  version: number;
  revision: string | null;
  settings: RawSettings;
  warning: string | null;
  recoveryCopies: SettingsCopy[];
}
export interface SaveSettingsRequest {
  expectedVersion: number;
  expectedRevision: string | null;
  settings: RawSettings;
}
export interface SavedSettings { version: number; revision: string }
export interface WorkspaceSettings { settings: RawSettings; revision: string | null; warning: string | null }
export interface LocalFonts { families: string[]; truncated: boolean }

export function isRawSettings(value: unknown): value is RawSettings {
  let nodes = 0;
  function safe(value: unknown, depth: number): value is JsonValue {
    if (++nodes > 4096 || depth > 16) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 256 && value.every(item => safe(item, depth + 1));
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    const entries = Object.entries(value);
    return entries.length <= 256 && entries.every(([key, item]) => key.length > 0
      && new TextEncoder().encode(key).byteLength <= 256 && !key.includes('\0')
      && !['__proto__', 'prototype', 'constructor'].includes(key) && safe(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !safe(value, 0)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536;
}

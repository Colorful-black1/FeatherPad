import { callCommand, isRecord } from './invoke';
import type { FileRef } from '../shared/contracts/files';
import { isRawSettings, type LoadedSettings, type LocalFonts, type SaveSettingsRequest,
  type SavedSettings, type WorkspaceSettings } from '../shared/contracts/settings';

const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const optionalRevision = (value: unknown): value is string | null => value === null || revision(value);
const warning = (value: unknown): value is string | null => value === null || typeof value === 'string';
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function isLoadedSettings(value: unknown): value is LoadedSettings {
  return isRecord(value) && value.schemaVersion === 1 && version(value.version) && optionalRevision(value.revision)
    && (value.revision !== null || value.version === 0) && isRawSettings(value.settings) && warning(value.warning)
    && Array.isArray(value.recoveryCopies) && value.recoveryCopies.length <= 16
    && value.recoveryCopies.every(copy => isRecord(copy) && uuid(copy.id) && version(copy.version));
}
export function isSavedSettings(value: unknown): value is SavedSettings {
  return isRecord(value) && version(value.version) && value.version > 0 && revision(value.revision);
}
export function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  return isRecord(value) && isRawSettings(value.settings) && optionalRevision(value.revision) && warning(value.warning);
}
export function isLocalFonts(value: unknown): value is LocalFonts {
  return isRecord(value) && typeof value.truncated === 'boolean' && Array.isArray(value.families)
    && value.families.length > 0 && value.families.length <= 4096
    && value.families.every(name => typeof name === 'string' && name.length > 0 && name.length <= 32 && !name.includes('\0'));
}

export const settingsBridge = {
  load: () => callCommand('load_settings', {}, isLoadedSettings),
  save: (request: SaveSettingsRequest) => callCommand('save_settings', { ...request },
    (value): value is SavedSettings => isSavedSettings(value) && value.version === request.expectedVersion + 1),
  restore: (request: { expectedVersion: number; expectedRevision: string | null; recoveryId: string }) =>
    callCommand('restore_settings', { ...request },
      (value): value is SavedSettings => isSavedSettings(value) && value.version === request.expectedVersion + 1),
  workspace: (root: FileRef) => callCommand('load_workspace_settings', { root }, isWorkspaceSettings),
  fonts: () => callCommand('list_font_families', {}, isLocalFonts),
};

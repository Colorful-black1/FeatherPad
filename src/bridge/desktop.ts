import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FileRef, ResultEnvelope } from '../shared/contracts/files';
import { callCommand, isRecord } from './invoke';
import { isFileRef } from './files';

export interface RoutedDesktopTarget {
  path: string;
  kind: 'file' | 'directory';
  ref: FileRef;
  displayName: string;
  goto: { path: string; line: number; column: number } | null;
}

export interface DesktopDelivery {
  requestId: string;
  windowId: string;
  wait: boolean;
  targets: RoutedDesktopTarget[];
  failures: string[];
}

export interface DesktopWindowResult { windowId: string }
export interface FocusDesktopWindowResult { focused: true }
export interface CompleteDesktopRequestResult { completed: true }
export interface RemoveWindowSessionResult { removed: boolean }
export interface DesktopIntegrationStatus {
  runtimeMode: 'installed' | 'portable';
  dataRoot: string;
  executablePath: string;
  fileAssociation: boolean;
  contextMenu: boolean;
  supportedExtensions: string[];
  changesDefaultApp: false;
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function positiveLocation(value: unknown): boolean {
  return isRecord(value) && safeText(value.path, 32_767)
    && Number.isSafeInteger(value.line) && (value.line as number) > 0
    && Number.isSafeInteger(value.column) && (value.column as number) > 0;
}

function isRoutedTarget(value: unknown): value is RoutedDesktopTarget {
  return isRecord(value) && safeText(value.path, 32_767)
    && (value.kind === 'file' || value.kind === 'directory')
    && isFileRef(value.ref) && safeText(value.displayName, 32_767)
    && (value.goto === null || positiveLocation(value.goto));
}

export function isDesktopDelivery(value: unknown): value is DesktopDelivery {
  return isRecord(value) && safeText(value.requestId, 128) && safeText(value.windowId, 128)
    && typeof value.wait === 'boolean' && Array.isArray(value.targets)
    && value.targets.length <= 65 && value.targets.every(isRoutedTarget)
    && Array.isArray(value.failures) && value.failures.length <= 65
    && value.failures.every(failure => safeText(failure, 4096));
}

export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const native = Reflect.get(window, '__TAURI_INTERNALS__');
  return isRecord(native) && typeof native.invoke === 'function'
    && isRecord(native.metadata);
}

function isIntegrationStatus(value: unknown): value is DesktopIntegrationStatus {
  return isRecord(value)
    && (value.runtimeMode === 'installed' || value.runtimeMode === 'portable')
    && safeText(value.dataRoot, 32_767) && safeText(value.executablePath, 32_767)
    && typeof value.fileAssociation === 'boolean' && typeof value.contextMenu === 'boolean'
    && Array.isArray(value.supportedExtensions) && value.supportedExtensions.length <= 64
    && value.supportedExtensions.every(extension => safeText(extension, 32))
    && value.changesDefaultApp === false;
}

export function currentWindowId(): string {
  if (!isDesktopRuntime()) return 'main';
  return getCurrentWindow().label;
}

export const desktopBridge = {
  takeRequests: () => callCommand('take_desktop_requests', {}, (value): value is DesktopDelivery[] =>
    Array.isArray(value) && value.length <= 128 && value.every(isDesktopDelivery)),
  complete: (requestId: string, ok: boolean, message: string) =>
    callCommand('complete_desktop_request', { request: { requestId, ok, message } },
      (value): value is CompleteDesktopRequestResult => isRecord(value) && value.completed === true),
  createWindow: (windowId?: string) => callCommand('create_desktop_window',
    { request: { ...(windowId ? { windowId } : {}) } },
    (value): value is DesktopWindowResult => isRecord(value)
      && safeText(value.windowId, 128) && (value.windowId === 'main' || value.windowId.startsWith('window-'))),
  focusWindow: (windowId: string) => callCommand('focus_desktop_window', { request: { windowId } },
    (value): value is FocusDesktopWindowResult => isRecord(value) && value.focused === true),
  removeCurrentWindowSession: () => callCommand('remove_desktop_window_session', {},
    (value): value is RemoveWindowSessionResult => isRecord(value) && typeof value.removed === 'boolean'),
  getIntegration: () => callCommand('get_desktop_integration', {}, isIntegrationStatus),
  setIntegration: (fileAssociation: boolean, contextMenu: boolean) =>
    callCommand('set_desktop_integration', { request: { fileAssociation, contextMenu } },
      isIntegrationStatus),
};

export type DesktopRequestListener = (delivery: DesktopDelivery) => void;

export function requestDesktopRefresh(): Promise<ResultEnvelope<DesktopDelivery[]>> {
  return desktopBridge.takeRequests();
}

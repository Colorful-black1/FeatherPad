import { invoke } from '@tauri-apps/api/core';
import { errorCodes, type AppError, type ResultEnvelope } from '../shared/contracts/files';

export type Transport = (command: string, args: Record<string, unknown>) => Promise<unknown>;
const nativeTransport: Transport = (command, args) => invoke<unknown>(command, args);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppError(value: unknown): value is AppError {
  return isRecord(value) && errorCodes.some(code => code === value.code)
    && typeof value.message === 'string' && typeof value.retryable === 'boolean';
}

export async function callCommand<T>(
  command: string, args: Record<string, unknown>, isValue: (value: unknown) => value is T,
  transport: Transport = nativeTransport,
): Promise<ResultEnvelope<T>> {
  try {
    const envelope = await transport(command, args);
    if (isRecord(envelope)) {
      if (envelope.ok === true && isValue(envelope.value)) return { ok: true, value: envelope.value };
      if (envelope.ok === false && isAppError(envelope.error)) return { ok: false, error: envelope.error };
    }
    return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '无法识别本地服务返回结果。', retryable: true } };
  } catch {
    return { ok: false, error: { code: 'IPC_UNAVAILABLE', message: '无法连接本地文件服务，请使用桌面应用重试。', retryable: true } };
  }
}

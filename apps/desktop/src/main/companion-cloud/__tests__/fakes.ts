import { vi } from 'vitest';
import { createCompanionCloudState } from '../state.js';
import type { CompanionApi } from '../types.js';

/** Same shape as chatServer's response error: code as message, plus status/details. */
export function rejection(status: number, code: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { status, details });
}

export function memoryState(initial?: string) {
  const files = new Map<string, string>(initial ? [['state.json', initial]] : []);
  const state = createCompanionCloudState({
    filePath: 'state.json',
    io: { read: path => files.get(path) ?? null, write: (path, contents) => { files.set(path, contents); } },
  });
  return { state, files };
}

export type ApiHandler = (route: string, method: string, data: unknown, actorId?: string) => unknown;

export function fakeApi(handler: ApiHandler) {
  const calls: Array<{ route: string; method: string; data: unknown; actorId?: string }> = [];
  const api = vi.fn(async (route: string, method = 'GET', data?: unknown, actorId?: string) => {
    calls.push({ route, method, data, actorId });
    return handler(route, method, data, actorId);
  }) as unknown as CompanionApi;
  return { api, calls };
}

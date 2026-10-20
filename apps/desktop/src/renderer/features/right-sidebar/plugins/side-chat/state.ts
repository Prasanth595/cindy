export interface SideChatState {
  sessionId: string | null;
  deviceId: string | null;
}

export function hydrateSideChatState(raw: unknown): SideChatState {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null,
    deviceId: typeof value.deviceId === 'string' && value.deviceId ? value.deviceId : null,
  };
}

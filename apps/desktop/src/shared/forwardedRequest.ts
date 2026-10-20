/** Host-owned source evidence. It describes authorship, never execution permission. */
export interface ForwardedRequestSource {
  userText: string | null;
  sessionId?: string;
  clientId?: string;
}

/** Kept under the existing protected, non-human input receipt. */
export interface AgentRequestReceipt {
  kind: 'agent-request' | 'delegated-continuation';
  request?: ForwardedRequestSource;
}

export function readForwardedRequestSource(value: unknown): ForwardedRequestSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.userText === null) return { userText: null };
  if (typeof source.userText !== 'string' || typeof source.sessionId !== 'string'
    || !source.sessionId || typeof source.clientId !== 'string' || !source.clientId) return null;
  return { userText: source.userText, sessionId: source.sessionId, clientId: source.clientId };
}

/** JSON string quoting keeps an agent-written label inside the supplement. No trimming or summarizing. */
export function formatForwardedRequest(source: ForwardedRequestSource, supplement: string): string {
  return [
    source.userText === null
      ? '[来源] 未找到可核验的用户原话。'
      : '[来源] 用户原话由宿主从已接收的输入原样保留。',
    `用户原话：${JSON.stringify(source.userText ?? '')}`,
    `agent补充：${JSON.stringify(supplement)}`,
  ].join('\n');
}

/** Validate a peer host's receipt against the exact body it reserved for delivery. */
export function matchesForwardedRequest(source: ForwardedRequestSource, body: string): boolean {
  const lines = body.split('\n');
  if (lines.length !== 3 || !lines[2].startsWith('agent补充：')) return false;
  try {
    const supplement: unknown = JSON.parse(lines[2].slice('agent补充：'.length));
    return typeof supplement === 'string' && formatForwardedRequest(source, supplement) === body;
  } catch { return false; }
}

/** Main-process persistence capability: JSON / IPC cannot mint this key. */
export const FORWARDED_REQUEST_RECEIPT = Symbol('forwarded-request-receipt');

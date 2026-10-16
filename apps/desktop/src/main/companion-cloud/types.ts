/** The Chat Server request function owned by chatServer.ts (account/endpoint bound). */
export type CompanionApi = <T>(route: string, method?: string, data?: unknown, actorId?: string) => Promise<T>;

export interface CompanionLog {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Details of a definitive Chat Server rejection (`{ error: { code, details } }`),
 * or null when the error is anything else. chatServer.ts keeps the code as the
 * message and exposes `status` / `details` on its response error.
 */
export function chatRejection(error: unknown, status: number, code: string): Record<string, unknown> | null {
  if (!(error instanceof Error) || error.message !== code) return null;
  if ((error as { status?: unknown }).status !== status) return null;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : {};
}

export function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN';
}

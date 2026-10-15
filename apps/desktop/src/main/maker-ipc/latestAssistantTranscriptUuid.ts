import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';

const messageRowid = sql<number>`rowid`;

/**
 * 最近一条可见的顶层 assistant 的 SDK uuid（有 uuid、没有 parentUuid，与内存里
 * lastAssistantTranscriptUuid 同口径）。会话关闭会清掉内存值；关闭后再发的第一条用户消息
 * 靠它补回 transcriptParentUuid，让回退锚点不因断线 / 重启而丢失。
 */
export async function findLatestAssistantTranscriptUuid(sessionId: string): Promise<string | undefined> {
  const db = getDbClient().drizzle;
  const [sessionRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessionRow?.clearedAt ?? null;
  const rows = await db
    .select({ agentMeta: messages.agentMeta })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'assistant'),
      isNull(messages.rewindAt),
      clearedAt === null ? undefined : gt(messages.createdAt, clearedAt),
    ))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(30);
  for (const row of rows) {
    const meta = parseAgentMeta(row.agentMeta);
    const uuid = meta?.uuid;
    const parentUuid = meta?.parentUuid;
    if (typeof uuid === 'string' && uuid && !(typeof parentUuid === 'string' && parentUuid)) return uuid;
  }
  return undefined;
}

function parseAgentMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

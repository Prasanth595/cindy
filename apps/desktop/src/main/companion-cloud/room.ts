/** Reading a companion's 1:1 room: the conversation layer every device can see. */
import type { CompanionTranscriptMessage, CompanionTranscriptPage } from '../../shared/companionCloud.js';
import type { CompanionApi } from './types.js';

export interface CompanionRoomMessage {
  id: string;
  seq: string;
  authorId: string;
  author?: { kind?: string };
  origin?: string;
  deleted?: boolean;
  threadRootId?: string | null;
  createdAt: string;
  content?: Array<{ type?: string; text?: string; caption?: string; fallback?: string }>;
}

const PAGE = 100;

/** Visible user/assistant text of a room message; null for system rows, threads and deletions. */
export function roomMessageView(message: CompanionRoomMessage, botActorId: string): CompanionTranscriptMessage | null {
  if (message.deleted || message.origin === 'system' || message.threadRootId) return null;
  const text = (message.content ?? []).map(block => block.type === 'text' ? block.text ?? ''
    : block.type === 'media' ? `[附件: ${block.caption ?? '文件'}]` : block.fallback ?? '').filter(Boolean).join('\n').trim();
  const createdAt = Date.parse(message.createdAt);
  if (!text || !Number.isFinite(createdAt)) return null;
  return { id: message.id, seq: message.seq, role: message.authorId === botActorId ? 'assistant' : 'user', text, createdAt };
}

export async function readRoomPage(api: CompanionApi, roomId: string, before?: string): Promise<CompanionRoomMessage[]> {
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (before) query.set('before', before);
  const page = await api<CompanionRoomMessage[]>(`/conversations/${roomId}/messages?${query}`);
  return Array.isArray(page) ? page : [];
}

/** One page of the room for display, oldest first. */
export async function readTranscriptPage(api: CompanionApi, roomId: string, botActorId: string, before?: string): Promise<CompanionTranscriptPage> {
  const page = await readRoomPage(api, roomId, before);
  const messages = page.flatMap(message => roomMessageView(message, botActorId) ?? []).reverse();
  const oldest = page.reduce<string | undefined>((min, m) => min === undefined || BigInt(m.seq) < BigInt(min) ? m.seq : min, undefined);
  return { messages, ...(page.length === PAGE && oldest ? { nextBefore: oldest } : {}) };
}

/** Latest `limit` visible messages, oldest first. */
export async function readRecentRoomMessages(api: CompanionApi, roomId: string, botActorId: string, limit: number, maxPages = 5) {
  const collected: CompanionTranscriptMessage[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages && collected.length < limit; page += 1) {
    const result = await readTranscriptPage(api, roomId, botActorId, before);
    collected.unshift(...result.messages);
    if (!result.nextBefore) break;
    before = result.nextBefore;
  }
  return collected.slice(-limit);
}

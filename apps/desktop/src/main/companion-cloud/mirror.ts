/**
 * Home-only mirror of a companion's canonical Session into its 1:1 Chat Server room
 * (cloud-companions.md §4): user-visible messages and the companion's replies only,
 * deduplicated by local message id, resumed from a cursor after each successful import.
 */
import { createHash } from 'node:crypto';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import type { CompanionCloudState } from './state.js';
import { chatRejection, type CompanionApi } from './types.js';

export interface CompanionMirrorRow {
  id: string;
  clientId: string;
  role: string;
  content: string;
  agentMeta: string | null;
  createdAt: number;
}
export interface CompanionMirrorCursor { createdAt: number; id: string }

/** Rows of these inputs already live in the room, or came from it. */
export const COMPANION_DIRECT_CLIENT_PREFIX = 'chat-direct:';
export const COMPANION_HISTORY_CLIENT_PREFIX = 'cloud-history:';
export const COMPANION_BACKFILL_LIMIT = 200;
const BACKFILL_SCAN = 1000;
const PAGE = 200;
const MAX_PAGES = 10;
const BATCH_MESSAGES = 50;
// Chat Server accepts 256 KiB bodies; each message stays within its 64 KiB content limit.
const BATCH_BYTES = 200_000;
const PART_CHARS = 30_000;
const PART_BYTES = 60_000;
const RESCAN_WINDOW_MS = 10 * 60_000;
const RESCAN_LIMIT = 200;
const RECENT_IDS = 400;

const parse = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};

function attachmentNames(content: unknown): string[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const names: string[] = [];
  for (const [field, fallback] of [['images', '图片'], ['files', '文件']] as const) {
    const list = (content as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const name = [record.originalName, record.name].find((value): value is string => typeof value === 'string' && !!value.trim());
      names.push((name ?? fallback).replace(/[\r\n]+/g, ' ').slice(0, 200));
    }
  }
  return names;
}

/**
 * Host-stamped sender/source metadata (message-source.md). A user row carrying any of these
 * was sent by another task, teammate, plugin, IM channel, automation, Orca or a shared-task
 * member — not typed by the owner — so it never goes up as the owner's words.
 * `sourceDevice` (the owner on another device) is the one source that stays.
 */
const NON_OWNER_SOURCE_KEYS = ['origin', 'sourcePlugin', 'sharedTaskAuthor', 'imSource', 'hookSource', 'sourceGroup',
  'botTaskCoordination', 'autoReviewUserText', 'autoResume'] as const;

/** Room text of a canonical row, or null when the row is not part of the visible conversation. */
export function mirrorMessageText(row: CompanionMirrorRow): string | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  if (row.clientId.startsWith(COMPANION_DIRECT_CLIENT_PREFIX) || row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)) return null;
  const parsedMeta = parse(row.agentMeta);
  const meta = parsedMeta && typeof parsedMeta === 'object' ? parsedMeta as Record<string, unknown> : {};
  // Private/coordination replies are hidden in the local timeline as well; so are progress
  // commentary and sub-agent output, which are never a reply (bots.ts canonicalReplyVisibility).
  if (row.role === 'assistant' && (meta.botPrivateReply === true || meta.assistantPhase === 'commentary'
    || (meta.parentToolUseId ?? null) !== null || (meta.parent_tool_use_id ?? null) !== null
    // Claude sub-agent rows; same predicate as the renderer (a legacy transcript link is not one).
    || (typeof meta.parentUuid === 'string' && !!meta.parentUuid && isSubagentParentToolUseId(meta.parentUuid)))) return null;
  if (row.role === 'user' && NON_OWNER_SOURCE_KEYS.some(key => meta[key] !== undefined && meta[key] !== null && meta[key] !== false)) return null;
  const text = visibleMessageText(row.role, row.content);
  // Attachments count on their own: an images-only message is still the owner's message.
  // Hidden synthetic inputs carry no attachments, so they stay out.
  const names = row.role === 'user' ? attachmentNames(parse(row.content)) : [];
  const result = [text, ...names.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n').trim();
  return result || null;
}

/** Split into room-sized parts without breaking surrogate pairs. */
export function splitMirrorText(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest) {
    let size = Math.min(rest.length, PART_CHARS);
    while (size > 1 && Buffer.byteLength(JSON.stringify(rest.slice(0, size))) > PART_BYTES) size = Math.floor(size * 0.8);
    if (size > 1 && size < rest.length && /[\uD800-\uDBFF]/.test(rest[size - 1]!)) size -= 1;
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return parts;
}

interface ImportMessage {
  sourceId: string; authorId: string; createdAt: string; content: Array<{ type: 'text'; text: string }>;
}

export function createCompanionMirror(deps: {
  api: CompanionApi;
  state: CompanionCloudState;
  humanActorId: () => string;
  canonicalSession: (botId: string) => Promise<string | null>;
  /** Strictly after the cursor, ascending by (createdAt, id); user/assistant rows that were not rewound. */
  rowsAfter: (sessionId: string, cursor: CompanionMirrorCursor, limit: number) => Promise<CompanionMirrorRow[]>;
  /** Newest first, same filters as rowsAfter. */
  latestRows: (sessionId: string, limit: number) => Promise<CompanionMirrorRow[]>;
}) {
  async function ensureRoom(botId: string, actorId: string, name: string): Promise<string> {
    const known = deps.state.bot(botId);
    if (known?.actorId === actorId && known.roomId) return known.roomId;
    const body = { kind: 'direct', name: name.trim().slice(0, 160) || '伙伴', participants: [actorId], sourceId: actorId };
    let room: { id: string };
    try {
      room = await deps.api<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}`, ...body });
    } catch (error) {
      // An earlier attempt used another name; the room id is still keyed by the companion.
      if (!chatRejection(error, 409, 'OPERATION_CONFLICT')) throw error;
      const suffix = createHash('sha256').update(body.name).digest('hex').slice(0, 12);
      room = await deps.api<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}:${suffix}`, ...body });
    }
    deps.state.update(botId, actorId, entry => { entry.roomId = room.id; });
    return room.id;
  }

  /**
   * Import rows in order. With `advance`, the cursor moves past each fully imported row, but
   * never onto an imported (`cloud-history:`) row and never backwards. Imported ids are
   * remembered so the trailing re-scan does not send them again.
   */
  async function importRows(botId: string, actorId: string, roomId: string, sessionId: string, rows: CompanionMirrorRow[], advance = true) {
    const parts: Array<{ message: ImportMessage; row: number; last: boolean; bytes: number }> = [];
    rows.forEach((row, index) => {
      const text = mirrorMessageText(row);
      if (!text) return;
      const pieces = splitMirrorText(text);
      pieces.forEach((piece, n) => {
        const message: ImportMessage = {
          sourceId: `cindy:${sessionId}:${row.id}${n ? `:p${n}` : ''}`.slice(0, 200),
          authorId: row.role === 'user' ? deps.humanActorId() : actorId,
          createdAt: new Date(row.createdAt).toISOString(),
          content: [{ type: 'text', text: piece }],
        };
        parts.push({ message, row: index, last: n === pieces.length - 1, bytes: Buffer.byteLength(JSON.stringify(message)) });
      });
    });
    const moveTo = (upTo: number) => {
      if (!advance) return;
      let index = upTo;
      while (index >= 0 && rows[index]!.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)) index -= 1;
      if (index < 0) return;
      const row = rows[index]!;
      deps.state.update(botId, actorId, entry => {
        const current = entry.mirror?.sessionId === sessionId ? entry.mirror : undefined;
        if (current && (current.createdAt > row.createdAt || (current.createdAt === row.createdAt && current.id >= row.id))) return;
        entry.mirror = { sessionId, createdAt: row.createdAt, id: row.id, ...(current?.recent ? { recent: current.recent } : {}) };
      });
    };
    const remember = (ids: string[]) => {
      if (!ids.length) return;
      deps.state.update(botId, actorId, entry => {
        if (!entry.mirror || entry.mirror.sessionId !== sessionId) return;
        entry.mirror = { ...entry.mirror, recent: [...new Set([...(entry.mirror.recent ?? []), ...ids])].slice(-RECENT_IDS) };
      });
    };
    let start = 0;
    while (start < parts.length) {
      let end = start; let bytes = 0;
      while (end < parts.length && end - start < BATCH_MESSAGES && (end === start || bytes + parts[end]!.bytes <= BATCH_BYTES)) {
        bytes += parts[end]!.bytes; end += 1;
      }
      const batch = parts.slice(start, end).map(part => part.message);
      const operationId = `companion-import:${createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 48)}`;
      try {
        await deps.api(`/conversations/${roomId}/import`, 'POST', { operationId, messages: batch });
      } catch (error) {
        // The room went away (e.g. archived on the server): create it again next cycle.
        if (chatRejection(error, 404, 'CONVERSATION_NOT_FOUND')) deps.state.update(botId, actorId, entry => { delete entry.roomId; });
        throw error;
      }
      const tail = parts[end - 1]!;
      const done = tail.last ? tail.row : tail.row - 1;
      if (done >= 0) moveTo(done);
      remember([...new Set(parts.slice(start, end).filter(part => part.last).map(part => rows[part.row]!.id))]);
      start = end;
    }
    if (rows.length) moveTo(rows.length - 1);
  }

  /** One bounded pass; `drain` (before a hand-over) keeps paging until the backlog is empty. */
  async function syncBot(botId: string, actorId: string, name: string, options: { drain?: boolean } = {}): Promise<void> {
    const sessionId = await deps.canonicalSession(botId);
    if (!sessionId) return;
    const roomId = await ensureRoom(botId, actorId, name);
    const known = deps.state.bot(botId);
    const cursor = known?.actorId === actorId && known.mirror?.sessionId === sessionId ? known.mirror : null;
    if (!cursor) {
      // First run for this Session: only the most recent conversation goes up.
      const rows = (await deps.latestRows(sessionId, BACKFILL_SCAN)).reverse();
      const eligible = rows.flatMap((row, index) => mirrorMessageText(row) ? [index] : []);
      const from = eligible.length > COMPANION_BACKFILL_LIMIT ? eligible[eligible.length - COMPANION_BACKFILL_LIMIT]! : 0;
      if (rows.length) await importRows(botId, actorId, roomId, sessionId, rows.slice(from));
      else deps.state.update(botId, actorId, entry => { entry.mirror = { sessionId, createdAt: 0, id: '' }; });
      return;
    }
    // Assistant rows are stamped when they start and persisted later, and imported history can
    // carry a peer's clock: re-scan a trailing window behind the cursor for anything missed.
    // Server-side sourceId dedupe makes any repeat a no-op; recent ids avoid the request.
    const recent = new Set(cursor.recent ?? []);
    const behind = (row: CompanionMirrorRow) => row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.id <= cursor.id);
    const missed = (await deps.rowsAfter(sessionId, { createdAt: cursor.createdAt - RESCAN_WINDOW_MS, id: '' }, RESCAN_LIMIT))
      .filter(row => behind(row) && !recent.has(row.id) && mirrorMessageText(row));
    if (missed.length) await importRows(botId, actorId, roomId, sessionId, missed, false);
    let after: CompanionMirrorCursor = { createdAt: cursor.createdAt, id: cursor.id };
    for (let page = 0; options.drain || page < MAX_PAGES; page += 1) {
      const rows = await deps.rowsAfter(sessionId, after, PAGE);
      if (!rows.length) return;
      await importRows(botId, actorId, roomId, sessionId, rows);
      after = rows[rows.length - 1]!;
      if (rows.length < PAGE) return;
    }
  }

  return { ensureRoom, syncBot };
}

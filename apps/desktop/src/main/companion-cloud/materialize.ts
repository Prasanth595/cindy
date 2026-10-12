/**
 * Build or update the local companion from its cloud copy (cloud-companions.md §3.1 step 2-3):
 * profile, memories and own skills from the companion's preferences, then the latest room
 * history as local history, then a deterministic context rebuild. Nothing old is replayed.
 */
import type { CompanionMirrorCursor, CompanionMirrorRow } from './mirror.js';
import { COMPANION_HISTORY_CLIENT_PREFIX } from './mirror.js';
import { directRoomSourceId } from './directRoom.js';
import { readRecentRoomMessages } from './room.js';
import type { CompanionCloudState } from './state.js';
import { errorCode, type CompanionApi, type CompanionLog } from './types.js';
import { COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_SKILL_PREFIX } from './uploader.js';

export const COMPANION_HISTORY_LIMIT = 200;

export interface CompanionLocalProfile { status: string; displayName: string; description: string }

/** Local profile, Bot Home and Session operations, all through the existing services. */
export interface CompanionMaterializeHost {
  readProfile: (botId: string) => Promise<CompanionLocalProfile | null>;
  createProfile: (input: {
    id: string; name: string; description: string; identitySource: string; userContextSource: string; avatar: string | null;
  }) => Promise<void>;
  /** Also makes the profile active again. Undefined fields stay unchanged. */
  updateProfile: (input: {
    id: string; name: string; description?: string; identitySource?: string; userContextSource?: string;
  }) => Promise<void>;
  writeSystemPrompt: (botId: string, text: string) => Promise<void>;
  readMemory: (botId: string, filename: string) => Promise<string | null>;
  restoreMemory: (botId: string, filename: string, raw: string) => Promise<void>;
  removeMemory: (botId: string, filename: string) => Promise<void>;
  readSkill: (botId: string, slug: string) => Promise<string | null>;
  saveSkill: (botId: string, slug: string, content: string) => Promise<void>;
  removeSkill: (botId: string, slug: string) => Promise<void>;
  ensureCanonicalSession: (botId: string) => Promise<string>;
  /** Local user/assistant rows created at or after `fromMs` (dedupe against mirrored and delivered rows). */
  localMessageTimes: (sessionId: string, fromMs: number) => Promise<Array<{ role: string; createdAt: number; clientId: string }>>;
  insertHistory: (sessionId: string, row: { clientId: string; role: 'user' | 'assistant'; text: string; createdAt: number }) => Promise<void>;
  /** Rebuild the native context from DB history like a companion restart; never interrupts a turn. */
  rebuildContext: (sessionId: string) => Promise<'rebuilt' | 'busy'>;
  latestRows: (sessionId: string, limit: number) => Promise<CompanionMirrorRow[]>;
}

export interface CompanionMaterializeActor { id: string; externalId: string; name: string; avatar: string | null }

export interface CompanionMaterializeResult {
  created: boolean;
  inserted: number;
  rebuild: 'rebuilt' | 'busy' | 'skipped';
  /** Memories/skills that could not be written; logged, retried by the next materialize. */
  failures: number;
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function materializeCompanion(input: {
  api: CompanionApi;
  state: CompanionCloudState;
  host: CompanionMaterializeHost;
  actor: CompanionMaterializeActor;
  roomId: () => Promise<string>;
  log?: CompanionLog;
}): Promise<CompanionMaterializeResult> {
  const { api, state, host, actor, log } = input;
  const botId = actor.externalId;
  const rows = await api<Array<{ key: string; value: unknown }>>('/preferences', 'GET', undefined, actor.id);
  const prefs = new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
  const profile = record(prefs.get(COMPANION_PROFILE_KEY));

  const local = await host.readProfile(botId);
  if (local?.status === 'deleting') throw new Error('PROFILE_DELETING');
  const name = text(profile?.name)?.trim() || actor.name || local?.displayName || '伙伴';
  if (!local) {
    await host.createProfile({ id: botId, name, description: text(profile?.description) ?? '',
      identitySource: text(profile?.soul) ?? '', userContextSource: text(profile?.user) ?? '', avatar: actor.avatar });
  } else {
    await host.updateProfile({ id: botId, name, description: text(profile?.description),
      identitySource: text(profile?.soul), userContextSource: text(profile?.user) });
  }
  const systemPrompt = text(profile?.systemPrompt);
  if (systemPrompt !== undefined) await host.writeSystemPrompt(botId, systemPrompt);

  let failures = 0;
  const apply = async (kind: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { failures += 1; log?.warn('Companion content could not be restored', { actorId: actor.id, kind, code: errorCode(error) }); }
  };
  for (const [key, value] of prefs) {
    if (key.startsWith(COMPANION_MEMORY_PREFIX)) {
      const filename = key.slice(COMPANION_MEMORY_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('memory', async () => {
        const current = await host.readMemory(botId, filename);
        if (value === null) { if (current !== null) await host.removeMemory(botId, filename); }
        else if (content !== undefined && content !== current) await host.restoreMemory(botId, filename, content);
      });
    } else if (key.startsWith(COMPANION_SKILL_PREFIX)) {
      const slug = key.slice(COMPANION_SKILL_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('skill', async () => {
        const current = await host.readSkill(botId, slug);
        if (value === null) { if (current !== null) await host.removeSkill(botId, slug); }
        else if (content !== undefined && content !== current) await host.saveSkill(botId, slug, content);
      });
    }
  }

  const sessionId = await host.ensureCanonicalSession(botId);
  const inserted = await importCloudHistory({ api, host, sessionId, botActorId: actor.id, roomId: await input.roomId() });
  // Keep the mirror coherent: everything up to now is already in the room.
  const [latest] = await host.latestRows(sessionId, 1);
  const cursor: CompanionMirrorCursor = latest ? { createdAt: latest.createdAt, id: latest.id } : { createdAt: 0, id: '' };
  const known = state.bot(botId);
  const keepCursor = known?.actorId === actor.id && known.mirror?.sessionId === sessionId
    && (known.mirror.createdAt > cursor.createdAt || (known.mirror.createdAt === cursor.createdAt && known.mirror.id >= cursor.id));
  const needsRebuild = inserted > 0 || known?.pendingRebuild === true;
  state.update(botId, actor.id, entry => {
    delete entry.demoted;
    // Revisions may have moved on while another computer was the home.
    entry.prefsSeeded = false;
    if (!keepCursor) entry.mirror = { sessionId, ...cursor };
    if (needsRebuild) entry.pendingRebuild = true;
  });
  const rebuild = needsRebuild ? await rebuildPending({ state, host, botId, actorId: actor.id, sessionId }) : 'skipped';
  return { created: !local, inserted, rebuild, failures };
}

/** Insert the room's latest messages that are not already local, oldest first. */
export async function importCloudHistory(input: {
  api: CompanionApi;
  host: Pick<CompanionMaterializeHost, 'localMessageTimes' | 'insertHistory'>;
  sessionId: string;
  botActorId: string;
  roomId: string;
}): Promise<number> {
  const messages = await readRecentRoomMessages(input.api, input.roomId, input.botActorId, COMPANION_HISTORY_LIMIT);
  if (!messages.length) return 0;
  // Rows mirrored from this Session keep their local timestamp; the server does not
  // return import source ids, so (role, createdAt) identifies them.
  // Delivered direct-room messages are local rows with their own (later) timestamp;
  // their client id names the room message, so they are never inserted a second time.
  const local = await input.host.localMessageTimes(input.sessionId, messages[0]!.createdAt);
  const present = new Set(local.map(row => `${row.role}:${row.createdAt}`));
  const delivered = new Set(local.flatMap(row => directRoomSourceId(row.clientId) ?? []));
  let inserted = 0;
  for (const message of messages) {
    if (present.has(`${message.role}:${message.createdAt}`) || delivered.has(message.id)) continue;
    await input.host.insertHistory(input.sessionId, { clientId: `${COMPANION_HISTORY_CLIENT_PREFIX}${message.id}`,
      role: message.role, text: message.text, createdAt: message.createdAt });
    inserted += 1;
  }
  return inserted;
}

/** Rebuild now when idle; otherwise keep the flag for the next sync cycle. */
export async function rebuildPending(input: {
  state: CompanionCloudState;
  host: Pick<CompanionMaterializeHost, 'rebuildContext'>;
  botId: string;
  actorId: string;
  sessionId: string;
}): Promise<'rebuilt' | 'busy'> {
  const outcome = await input.host.rebuildContext(input.sessionId);
  if (outcome === 'rebuilt') input.state.update(input.botId, input.actorId, entry => { delete entry.pendingRebuild; });
  return outcome;
}

/**
 * Build or update the local companion from its cloud copy (cloud-companions.md §3.1 step 2-3):
 * profile, memories and own skills from the companion's preferences, then the latest room
 * history as local history, then a deterministic context rebuild. Nothing old is replayed.
 * Every local write is fenced by the owner that started it. The copy stays demoted (does not
 * run, upload or mirror) until everything is restored; a partial restore throws and the
 * automatic take-over retries it.
 */
import type { CompanionMirrorCursor, CompanionMirrorRow } from './mirror.js';
import { COMPANION_HISTORY_CLIENT_PREFIX } from './mirror.js';
import { directRoomSourceId } from './directRoom.js';
import { readRecentRoomMessages } from './room.js';
import type { CompanionCloudState } from './state.js';
import { errorCode, type CompanionApi, type CompanionLog } from './types.js';
import { COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_SKILL_PREFIX, TOMBSTONE_HASH, isCompanionProfileSnapshot, valueHash } from './uploader.js';

export const COMPANION_HISTORY_LIMIT = 200;

export interface CompanionLocalProfile { status: string; displayName: string; description: string }

/** The owner that started the operation; every host write checks it and aborts on change. */
export interface CompanionWriteFence {
  assertCurrent: () => void;
  signal?: AbortSignal;
}

/** Local profile, Bot Home and Session operations, all through the existing services. */
export interface CompanionMaterializeHost {
  readProfile: (botId: string) => Promise<CompanionLocalProfile | null>;
  /** The cloud avatar must be restored (an image that cannot be downloaded fails the call). */
  createProfile: (input: {
    id: string; name: string; description: string; identitySource: string; userContextSource: string; avatar: string | null;
  }, fence: CompanionWriteFence) => Promise<void>;
  /**
   * Also makes the profile active again. Undefined fields stay unchanged; a cloud avatar replaces
   * the local one (failing like createProfile), since the home publishes its avatar back.
   */
  updateProfile: (input: {
    id: string; name: string; description?: string; identitySource?: string; userContextSource?: string; avatar: string | null;
  }, fence: CompanionWriteFence) => Promise<void>;
  writeSystemPrompt: (botId: string, text: string, fence: CompanionWriteFence) => Promise<void>;
  /** Copy the companion's Home (identity, prompt, user file, memories, skills) aside; returns where. */
  backupHome?: (botId: string, fence: CompanionWriteFence) => Promise<string | null>;
  readMemory: (botId: string, filename: string) => Promise<string | null>;
  restoreMemory: (botId: string, filename: string, raw: string, fence: CompanionWriteFence) => Promise<void>;
  removeMemory: (botId: string, filename: string, fence: CompanionWriteFence) => Promise<void>;
  readSkill: (botId: string, slug: string) => Promise<string | null>;
  saveSkill: (botId: string, slug: string, content: string, enabled: boolean, fence: CompanionWriteFence) => Promise<void>;
  removeSkill: (botId: string, slug: string, fence: CompanionWriteFence) => Promise<void>;
  ensureCanonicalSession: (botId: string, fence: CompanionWriteFence) => Promise<string>;
  /**
   * Local rows created at or after `fromMs`, including rewound and deleted ones (`removed`):
   * dedupe against mirrored, delivered and deliberately removed messages.
   */
  localMessageTimes: (sessionId: string, fromMs: number) => Promise<Array<{ role: string; createdAt: number; clientId: string; removed?: boolean }>>;
  insertHistory: (sessionId: string, row: { clientId: string; role: 'user' | 'assistant'; text: string; createdAt: number }, fence: CompanionWriteFence) => Promise<void>;
  /** Rebuild the native context from DB history like a companion restart; never interrupts a turn. */
  rebuildContext: (sessionId: string, fence: CompanionWriteFence) => Promise<'rebuilt' | 'busy'>;
  /** Newest first; `excludeClientIdPrefix` leaves out rows whose client id starts with it. */
  latestRows: (sessionId: string, limit: number, options?: { excludeClientIdPrefix?: string }) => Promise<CompanionMirrorRow[]>;
}

export interface CompanionMaterializeActor { id: string; externalId: string; name: string; avatar: string | null }

export interface CompanionMaterializeResult {
  created: boolean;
  inserted: number;
  rebuild: 'rebuilt' | 'skipped';
  /** Where an existing, never-synced local copy was saved before being overwritten. */
  backup?: string | null;
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const noFence: CompanionWriteFence = { assertCurrent: () => undefined };

export async function materializeCompanion(input: {
  api: CompanionApi;
  state: CompanionCloudState;
  host: CompanionMaterializeHost;
  actor: CompanionMaterializeActor;
  roomId: () => Promise<string>;
  fence?: CompanionWriteFence;
  log?: CompanionLog;
  /** Publish the demotion (send guard, routines, lists) before the first local write. */
  onDemoted?: () => void;
}): Promise<CompanionMaterializeResult> {
  const { api, state, host, actor, log } = input;
  const fence = input.fence ?? noFence;
  /** Check the owner before and after each local step. */
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    fence.assertCurrent();
    const value = await run();
    fence.assertCurrent();
    return value;
  };
  const botId = actor.externalId;
  const rows = await step(() => api<Array<{ key: string; value: unknown; revision: number }>>('/preferences', 'GET', undefined, actor.id));
  const prefs = new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row]));
  const profileValue = prefs.get(COMPANION_PROFILE_KEY)?.value;
  const profile = isCompanionProfileSnapshot(profileValue) ? profileValue : null;
  const known = state.bot(botId);
  const knownPrefs = known?.actorId === actor.id ? known.prefs : {};

  const local = await step(() => host.readProfile(botId));
  if (local?.status === 'deleting') throw new Error('PROFILE_DELETING');
  // Not runnable here until the take-over completes: a half-restored copy must never run or
  // upload its stale files over the cloud values.
  fence.assertCurrent();
  state.update(botId, actor.id, entry => { entry.demoted = true; });
  input.onDemoted?.();
  // Without the home's profile snapshot this copy's own (or empty) profile would be published as
  // the companion's identity: wait (demoted, retried) until the home has uploaded one.
  if (!profile) throw new Error('PROFILE_SNAPSHOT_MISSING');
  // An existing local copy is saved before the cloud copy replaces (or deletes) its files.
  let backup: string | null | undefined;
  if (local && !(known?.actorId === actor.id && known.backedUp) && host.backupHome) {
    backup = await step(() => host.backupHome!(botId, fence));
    if (backup) log?.info?.('Companion local copy backed up before take-over', { actorId: actor.id, backup });
    // Once is enough: a take-over that fails later (e.g. avatar unavailable) retries without a new copy.
    state.update(botId, actor.id, entry => { entry.backedUp = true; });
  }
  const name = text(profile?.name)?.trim() || actor.name || local?.displayName || '伙伴';
  if (!local) {
    await step(() => host.createProfile({ id: botId, name, description: text(profile?.description) ?? '',
      identitySource: text(profile?.soul) ?? '', userContextSource: text(profile?.user) ?? '', avatar: actor.avatar }, fence));
  } else {
    await step(() => host.updateProfile({ id: botId, name, description: text(profile?.description),
      identitySource: text(profile?.soul), userContextSource: text(profile?.user), avatar: actor.avatar }, fence));
  }
  const systemPrompt = text(profile?.systemPrompt);
  if (systemPrompt !== undefined) await step(() => host.writeSystemPrompt(botId, systemPrompt, fence));

  // Keys whose value this device now has locally; only these may be tombstoned later.
  const applied = new Map<string, { hash: string; revision: number }>();
  const profileRow = prefs.get(COMPANION_PROFILE_KEY);
  if (profileRow && profile) applied.set(COMPANION_PROFILE_KEY, { hash: valueHash(profileRow.value), revision: profileRow.revision });
  let failures = 0;
  const apply = async (kind: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) {
      if (errorCode(error) === 'OWNER_CHANGED') throw error;
      failures += 1;
      log?.warn('Companion content could not be restored', { actorId: actor.id, kind, code: errorCode(error) });
    }
  };
  // The cloud copy wins: a tombstone deletes the local file (the copy was backed up above), so
  // the uploader can never bring deleted content back.
  for (const [key, row] of prefs) {
    const value = row.value;
    if (key.startsWith(COMPANION_MEMORY_PREFIX)) {
      const filename = key.slice(COMPANION_MEMORY_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('memory', async () => {
        const current = await host.readMemory(botId, filename);
        if (value === null) {
          if (current !== null) await step(() => host.removeMemory(botId, filename, fence));
          applied.set(key, { hash: TOMBSTONE_HASH, revision: row.revision });
          return;
        }
        if (content === undefined) return;
        if (content !== current) await step(() => host.restoreMemory(botId, filename, content, fence));
        applied.set(key, { hash: valueHash(value), revision: row.revision });
      });
    } else if (key.startsWith(COMPANION_SKILL_PREFIX)) {
      const slug = key.slice(COMPANION_SKILL_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('skill', async () => {
        const current = await host.readSkill(botId, slug);
        if (value === null) {
          if (current !== null) await step(() => host.removeSkill(botId, slug, fence));
          applied.set(key, { hash: TOMBSTONE_HASH, revision: row.revision });
          return;
        }
        if (content === undefined) return;
        // Always written: also sets the cloud's enabled state, even when the body is unchanged.
        await step(() => host.saveSkill(botId, slug, content, record(value)?.enabled !== false, fence));
        applied.set(key, { hash: valueHash(value), revision: row.revision });
      });
    }
  }

  if (failures > 0) {
    // Keep what was restored (so the retry does not back the copy up again) and stay demoted.
    state.update(botId, actor.id, entry => { for (const [key, value] of applied) entry.prefs[key] = { ...value, local: true }; });
    throw new Error('RESTORE_INCOMPLETE');
  }

  const sessionId = await step(() => host.ensureCanonicalSession(botId, fence));
  const roomId = await step(() => input.roomId());
  const inserted = await importCloudHistory({ api, host, sessionId, botActorId: actor.id, roomId, fence });
  // Keep the mirror coherent: everything up to now is already in the room. Imported history
  // (possibly stamped by a peer's clock) never sets the cursor.
  const [latest] = await host.latestRows(sessionId, 1, { excludeClientIdPrefix: COMPANION_HISTORY_CLIENT_PREFIX });
  const cursor: CompanionMirrorCursor = latest ? { createdAt: latest.createdAt, id: latest.id } : { createdAt: 0, id: '' };
  const keepCursor = known?.actorId === actor.id && known.mirror?.sessionId === sessionId
    && (known.mirror.createdAt > cursor.createdAt || (known.mirror.createdAt === cursor.createdAt && known.mirror.id >= cursor.id));
  const needsRebuild = inserted > 0 || known?.pendingRebuild === true;
  fence.assertCurrent();
  state.update(botId, actor.id, entry => {
    // Revisions may have moved on while another computer was the home.
    entry.prefsSeeded = false;
    for (const [key, value] of applied) entry.prefs[key] = { ...value, local: true };
    if (!keepCursor) entry.mirror = { sessionId, ...cursor };
    if (needsRebuild) entry.pendingRebuild = true;
  });
  // Rebuild while still demoted: a failure, or a turn still running (`busy`), leaves the copy
  // demoted and the automatic take-over retries until the rebuild completes.
  const rebuild = needsRebuild ? await rebuildPending({ state, host, botId, actorId: actor.id, sessionId, fence }) : 'skipped';
  if (rebuild === 'busy') throw new Error('CONTEXT_REBUILD_PENDING');
  fence.assertCurrent();
  state.update(botId, actor.id, entry => {
    delete entry.demoted;
    // The next take-over (after this copy hands the companion away again) backs it up anew.
    delete entry.backedUp;
  });
  return { created: !local, inserted, rebuild, ...(backup !== undefined ? { backup } : {}) };
}

/** Insert the room's latest messages that are not already local, oldest first. */
export async function importCloudHistory(input: {
  api: CompanionApi;
  host: Pick<CompanionMaterializeHost, 'localMessageTimes' | 'insertHistory'>;
  sessionId: string;
  botActorId: string;
  roomId: string;
  fence?: CompanionWriteFence;
}): Promise<number> {
  const fence = input.fence ?? noFence;
  const messages = await readRecentRoomMessages(input.api, input.roomId, input.botActorId, COMPANION_HISTORY_LIMIT);
  if (!messages.length) return 0;
  // Rows already imported, and delivered direct-room messages, name their room message in the
  // client id: exact. Rows mirrored from this Session keep their local timestamp; the server
  // does not return import source ids, so (role, createdAt) identifies only those. Rewound or
  // deleted rows count too: what the owner removed here does not come back.
  const local = await input.host.localMessageTimes(input.sessionId, messages[0]!.createdAt);
  const known = new Set(local.flatMap(row => (row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)
    ? row.clientId.slice(COMPANION_HISTORY_CLIENT_PREFIX.length) : directRoomSourceId(row.clientId)) ?? []));
  const present = new Set(local.flatMap(row => row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX) ? []
    : row.removed ? [`user:${row.createdAt}`, `assistant:${row.createdAt}`] : [`${row.role}:${row.createdAt}`]));
  let inserted = 0;
  for (const message of messages) {
    if (known.has(message.id) || present.has(`${message.role}:${message.createdAt}`)) continue;
    fence.assertCurrent();
    await input.host.insertHistory(input.sessionId, { clientId: `${COMPANION_HISTORY_CLIENT_PREFIX}${message.id}`,
      role: message.role, text: message.text, createdAt: message.createdAt }, fence);
    inserted += 1;
  }
  fence.assertCurrent();
  return inserted;
}

/** Rebuild now when idle; otherwise keep the flag for the next sync cycle. */
export async function rebuildPending(input: {
  state: CompanionCloudState;
  host: Pick<CompanionMaterializeHost, 'rebuildContext'>;
  botId: string;
  actorId: string;
  sessionId: string;
  fence?: CompanionWriteFence;
}): Promise<'rebuilt' | 'busy'> {
  const fence = input.fence ?? noFence;
  fence.assertCurrent();
  const outcome = await input.host.rebuildContext(input.sessionId, fence);
  fence.assertCurrent();
  if (outcome === 'rebuilt') input.state.update(input.botId, input.actorId, entry => { delete entry.pendingRebuild; });
  return outcome;
}

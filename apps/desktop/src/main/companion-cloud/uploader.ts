/**
 * Home-only upload of a companion's profile, memories and own skills as Chat Server
 * preferences of the companion actor (cloud-companions.md §2). Only changed values
 * are written; values that disappeared locally become `null` tombstones.
 */
import { createHash } from 'node:crypto';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';

export const COMPANION_PROFILE_KEY = 'companion.profile.v1';
export const COMPANION_MEMORY_PREFIX = 'companion.memory.v1:';
export const COMPANION_SKILL_PREFIX = 'companion.skill.v1:';
const OWNED_PREFIXES = [COMPANION_PROFILE_KEY, COMPANION_MEMORY_PREFIX, COMPANION_SKILL_PREFIX];
const MAX_KEY_LENGTH = 160;
export const COMPANION_VALUE_MAX_BYTES = 60 * 1024;

export interface CompanionPreferenceValue { key: string; value: unknown }

/** Stable JSON (sorted object keys): the server's JSONB does not preserve key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const TOMBSTONE_HASH = sha256('null');

export function createCompanionUploader(deps: {
  api: CompanionApi;
  state: CompanionCloudState;
  readValues: (botId: string) => Promise<CompanionPreferenceValue[]>;
  log?: CompanionLog;
  maxValueBytes?: number;
}) {
  const maxBytes = deps.maxValueBytes ?? COMPANION_VALUE_MAX_BYTES;
  const owned = (key: string) => OWNED_PREFIXES.some(prefix => key === prefix || (prefix.endsWith(':') && key.startsWith(prefix)));

  async function write(actorId: string, key: string, value: unknown, json: string, expectedRevision: number) {
    const operationId = `cpref:${sha256(`${key}\n${expectedRevision}\n${json}`).slice(0, 48)}`;
    const result = await deps.api<{ revision?: number }>('/preferences', 'POST', { operationId, key, expectedRevision, value }, actorId);
    return typeof result?.revision === 'number' ? result.revision : expectedRevision + 1;
  }

  /** Read the server's revisions once, so a lost state file neither conflicts forever nor leaves stale keys behind. */
  async function seed(botId: string, actorId: string) {
    const rows = await deps.api<Array<{ key: string; value: unknown; revision: number }>>('/preferences', 'GET', undefined, actorId);
    deps.state.update(botId, actorId, entry => {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!owned(row.key) || typeof row.revision !== 'number') continue;
        entry.prefs[row.key] = { hash: sha256(canonicalJson(row.value)), revision: row.revision };
      }
      entry.prefsSeeded = true;
    });
  }

  async function syncBot(botId: string, actorId: string): Promise<void> {
    const values = await deps.readValues(botId);
    if (deps.state.bot(botId)?.actorId !== actorId || !deps.state.bot(botId)?.prefsSeeded) await seed(botId, actorId);
    const desired = new Map<string, unknown>();
    for (const { key, value } of values) desired.set(key, value);
    for (const [key, entry] of Object.entries(deps.state.bot(botId)?.prefs ?? {})) {
      if (!desired.has(key) && entry.hash !== TOMBSTONE_HASH) desired.set(key, null);
    }
    for (const [key, value] of desired) {
      const json = canonicalJson(value);
      if (key.length > MAX_KEY_LENGTH || Buffer.byteLength(json) > maxBytes) {
        deps.log?.warn('Companion value too large to upload; skipped', { actorId, keyKind: key.split(':')[0], bytes: Buffer.byteLength(json) });
        continue;
      }
      const hash = sha256(json);
      const prior = deps.state.bot(botId)?.prefs[key];
      if (prior ? prior.hash === hash : value === null) continue;
      let revision: number;
      try {
        revision = await write(actorId, key, value, json, prior?.revision ?? 0);
      } catch (error) {
        const conflict = chatRejection(error, 409, 'REVISION_CONFLICT');
        if (!conflict || typeof conflict.revision !== 'number') throw error;
        revision = await write(actorId, key, value, json, conflict.revision);
      }
      deps.state.update(botId, actorId, entry => { entry.prefs[key] = { hash, revision }; });
    }
  }

  return {
    syncBot,
    /** Errors are logged per companion and retried on the next cycle. */
    async syncAll(bots: Array<{ botId: string; actorId: string }>): Promise<void> {
      for (const { botId, actorId } of bots) {
        try { await syncBot(botId, actorId); }
        catch (error) { deps.log?.warn('Companion upload will retry', { actorId, code: errorCode(error) }); }
      }
    },
  };
}

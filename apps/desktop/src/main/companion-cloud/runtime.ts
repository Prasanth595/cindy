/**
 * Background sync owned by one Chat Server instance (one account + endpoint).
 * Started only when the server announces companion homes; failures are logged and
 * retried on the next cycle, never surfaced to chat.
 */
import type { CompanionHomeRegistry } from './homes.js';
import { createCompanionMirror, type CompanionMirrorCursor, type CompanionMirrorRow } from './mirror.js';
import type { CompanionCloudState } from './state.js';
import { errorCode, type CompanionApi, type CompanionLog } from './types.js';
import { createCompanionUploader, type CompanionPreferenceValue } from './uploader.js';

/** Electron/database side of the feature, wired in register.ts. */
export interface CompanionCloudHost {
  homes: CompanionHomeRegistry;
  openState: (endpoint: string, humanActorId: string, current: () => boolean) => CompanionCloudState;
  readValues: (botId: string) => Promise<CompanionPreferenceValue[]>;
  canonicalSession: (botId: string) => Promise<string | null>;
  rowsAfter: (sessionId: string, cursor: CompanionMirrorCursor, limit: number) => Promise<CompanionMirrorRow[]>;
  latestRows: (sessionId: string, limit: number) => Promise<CompanionMirrorRow[]>;
  /** Hand a room message to the companion's canonical Session as an ordinary user message. */
  deliverToCanonical: (botId: string, text: string, clientId: string) => Promise<{ ok: true } | { ok: false; errorCode: string }>;
  /** Local profile, memory, skill or canonical message change of a companion. */
  onLocalChange?: (listener: (botId: string) => void) => () => void;
}

export interface CompanionCloudBot { botId: string; actorId: string; name: string }

export interface CompanionCloudRuntime {
  readonly state: CompanionCloudState;
  kickUploads: (botId?: string) => void;
  kickMirror: (botId?: string) => void;
  roomIdFor: (botId: string) => string | null;
  isDirectRoom: (roomId: string) => boolean;
  /** One full upload + mirror pass (tests and explicit refresh). */
  syncNow: () => Promise<void>;
  dispose: () => void;
}

let active: CompanionCloudRuntime | null = null;
/** The running sync of the current account, or null when the feature is off. */
export function activeCompanionCloud(): CompanionCloudRuntime | null { return active; }

type Only = Set<string> | null | undefined;
const union = (left: Only, right: Set<string> | null): Only =>
  left === null || right === null ? null : new Set([...(left ?? []), ...right]);

export function startCompanionCloud(input: {
  api: CompanionApi;
  host: CompanionCloudHost;
  endpoint: string;
  humanActorId: string;
  current: () => boolean;
  /** Active local companions whose home is this computer. */
  bots: () => CompanionCloudBot[];
  log?: CompanionLog;
  uploadIntervalMs?: number;
  mirrorIntervalMs?: number;
}): CompanionCloudRuntime {
  const state = input.host.openState(input.endpoint, input.humanActorId, input.current);
  const uploader = createCompanionUploader({ api: input.api, state, readValues: input.host.readValues, log: input.log });
  const mirror = createCompanionMirror({ api: input.api, state, humanActorId: () => input.humanActorId,
    canonicalSession: input.host.canonicalSession, rowsAfter: input.host.rowsAfter, latestRows: input.host.latestRows });
  let disposed = false;
  const live = () => !disposed && input.current();
  const pick = (only: Set<string> | null) => input.bots().filter(bot => !only || only.has(bot.botId));

  function loop(run: (only: Set<string> | null) => Promise<void>, intervalMs: number, debounceMs: number) {
    let busy: Promise<void> | undefined;
    let queued: Only;
    let kicked: Only;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const fire = (only: Set<string> | null): Promise<void> => {
      if (!live()) return Promise.resolve();
      if (busy) { queued = union(queued, only); return busy; }
      busy = run(only).catch(error => { input.log?.warn('Companion sync cycle failed', { code: errorCode(error) }); })
        .finally(() => {
          busy = undefined;
          const next = queued; queued = undefined;
          if (next !== undefined) void fire(next);
        });
      return busy;
    };
    const interval = setInterval(() => { void fire(null); }, intervalMs);
    interval.unref?.();
    return {
      run: () => fire(null),
      kick(botId?: string) {
        kicked = union(kicked, botId === undefined ? null : new Set([botId]));
        clearTimeout(debounce);
        debounce = setTimeout(() => { const only = kicked ?? null; kicked = undefined; void fire(only); }, debounceMs);
        debounce.unref?.();
      },
      dispose() { clearInterval(interval); clearTimeout(debounce); },
    };
  }

  const uploads = loop(async only => uploader.syncAll(pick(only)), input.uploadIntervalMs ?? 60_000, 15_000);
  const mirrors = loop(async only => {
    for (const bot of pick(only)) {
      if (!live()) return;
      try { await mirror.syncBot(bot.botId, bot.actorId, bot.name); }
      catch (error) { input.log?.warn('Companion conversation mirror will retry', { actorId: bot.actorId, code: errorCode(error) }); }
    }
  }, input.mirrorIntervalMs ?? 15_000, 2_000);
  const unsubscribe = input.host.onLocalChange?.(botId => { mirrors.kick(botId); uploads.kick(botId); });

  const runtime: CompanionCloudRuntime = {
    state,
    kickUploads: botId => uploads.kick(botId),
    kickMirror: botId => mirrors.kick(botId),
    roomIdFor: botId => state.bot(botId)?.roomId ?? null,
    isDirectRoom: roomId => state.botForRoom(roomId) !== null,
    syncNow: async () => { await uploads.run(); await mirrors.run(); },
    dispose() {
      disposed = true;
      uploads.dispose(); mirrors.dispose(); unsubscribe?.();
      if (active === runtime) active = null;
    },
  };
  active = runtime;
  // First pass soon after start; later passes follow the intervals and local changes.
  uploads.kick(); mirrors.kick();
  return runtime;
}

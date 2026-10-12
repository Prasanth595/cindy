/**
 * Background sync and home changes owned by one Chat Server instance (one account +
 * endpoint). Started only when the server announces companion homes; background
 * failures are logged and retried, never surfaced to chat.
 */
import type {
  CompanionCloudActionResult,
  CompanionTranscriptPage,
  CompanionTransferTarget,
} from '../../shared/companionCloud.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { CompanionHomeRegistry } from './homes.js';
import { materializeCompanion, rebuildPending, type CompanionMaterializeHost, type CompanionMaterializeResult } from './materialize.js';
import { createCompanionMirror, type CompanionMirrorCursor, type CompanionMirrorRow } from './mirror.js';
import { readTranscriptPage } from './room.js';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';
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
  /** Local side of taking a companion over; absent disables take-over and auto-materialize. */
  materializer?: Omit<CompanionMaterializeHost, 'latestRows'>;
  /** The owner's devices from device-link. */
  listDevices?: () => Promise<DeviceLinkDeviceView[]>;
}

export interface CompanionCloudBot { botId: string; actorId: string; name: string }
/** Live actor record owned by chatServer.ts; home changes are written back in place. */
export interface CompanionRuntimeActor {
  id: string; kind: string; externalId: string; name: string; avatar?: string | null; homeDeviceId?: string | null;
  /** Retired in the cloud (deleted on its home); ignored everywhere. */
  disabled?: boolean;
}

export interface CompanionCloudRuntime {
  readonly state: CompanionCloudState;
  kickUploads: (botId?: string) => void;
  kickMirror: (botId?: string) => void;
  roomIdFor: (botId: string) => string | null;
  isDirectRoom: (roomId: string) => boolean;
  /** One full upload + mirror pass (tests and explicit refresh). */
  syncNow: () => Promise<void>;
  /** Demote local copies homed elsewhere and materialize companions handed to this computer. */
  reconcile: (localProfiles: Array<{ id: string; status: string }>) => void;
  takeOver: (botId: string) => Promise<CompanionCloudActionResult>;
  transfer: (botId: string, targetDeviceId: string) => Promise<CompanionCloudActionResult>;
  transferTargets: () => Promise<CompanionTransferTarget[]>;
  transcript: (botId: string, before?: string) => Promise<CompanionTranscriptPage>;
  /** The companion was deleted on its home (this computer): retire its cloud actor. */
  retire: (botId: string) => Promise<void>;
  dispose: () => void;
}

let active: CompanionCloudRuntime | null = null;
/** The running sync of the current account, or null when the feature is off. */
export function activeCompanionCloud(): CompanionCloudRuntime | null { return active; }

type Only = Set<string> | null | undefined;
const union = (left: Only, right: Set<string> | null): Only =>
  left === null || right === null ? null : new Set([...(left ?? []), ...right]);

const TRANSPORT_CODES = /^(REQUEST_TIMEOUT|CHAT_ENDPOINT_UNAVAILABLE|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)$/;
/** The server could not be reached (or is temporarily failing): retry later. */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status >= 500 || status === 408 || status === 429;
  const code = (error as { code?: unknown }).code;
  return TRANSPORT_CODES.test(error.message) || (typeof code === 'string' && TRANSPORT_CODES.test(code));
}

function actionFailure(error: unknown, fallback: 'FAILED' | 'OFFLINE' = 'FAILED'): CompanionCloudActionResult {
  const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
  if (conflict) return { ok: false, code: 'HOME_CONFLICT', homeDeviceId: typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null };
  return { ok: false, code: isUnreachable(error) ? 'OFFLINE' : fallback };
}

const AUTO_RETRY_MS = 60_000;

/** Same computers Orca may run work on (orcaRemoteWorkers.isExecutionDeviceCandidate). */
export function isCompanionTransferTarget(device: DeviceLinkDeviceView): boolean {
  return device.online && device.remoteControlEnabled && device.controlEnabled && !device.isSelf && !isMobilePlatform(device.platform);
}

export function startCompanionCloud(input: {
  api: CompanionApi;
  host: CompanionCloudHost;
  endpoint: string;
  humanActorId: string;
  selfDeviceId?: string;
  current: () => boolean;
  /** Active local companions whose home is this computer (and not demoted). */
  bots: () => CompanionCloudBot[];
  /** The account's actors as last read by register(). */
  actors?: () => CompanionRuntimeActor[];
  /** Re-read actors now (forced register). */
  refresh?: () => Promise<void>;
  /** Publish the registry snapshot after a local home change. */
  publish?: () => void;
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
  const actorOf = (botId: string) => (input.actors?.() ?? []).find(a => a.kind === 'bot' && !a.disabled && (a.externalId === botId || a.id === botId));
  const publish = () => { if (live()) input.publish?.(); };

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
      try {
        if (state.bot(bot.botId)?.pendingRebuild && input.host.materializer) {
          const sessionId = await input.host.canonicalSession(bot.botId);
          if (sessionId) await rebuildPending({ state, host: input.host.materializer, botId: bot.botId, actorId: bot.actorId, sessionId });
        }
        await mirror.syncBot(bot.botId, bot.actorId, bot.name);
      } catch (error) { input.log?.warn('Companion conversation mirror will retry', { actorId: bot.actorId, code: errorCode(error) }); }
    }
  }, input.mirrorIntervalMs ?? 15_000, 2_000);
  const unsubscribe = input.host.onLocalChange?.(botId => { mirrors.kick(botId); uploads.kick(botId); });

  // One materialize per companion at a time; take-over and automatic runs share it.
  const materializing = new Map<string, Promise<CompanionMaterializeResult>>();
  const autoRetryAt = new Map<string, number>();
  function materialize(actor: CompanionRuntimeActor): Promise<CompanionMaterializeResult> {
    const materializer = input.host.materializer;
    if (!materializer) return Promise.reject(new Error('MATERIALIZE_UNAVAILABLE'));
    const botId = actor.externalId;
    const pending = materializing.get(botId);
    if (pending) return pending;
    const run = materializeCompanion({ api: input.api, state, log: input.log, host: { ...materializer, latestRows: input.host.latestRows },
      actor: { id: actor.id, externalId: botId, name: actor.name, avatar: actor.avatar ?? null },
      roomId: () => mirror.ensureRoom(botId, actor.id, actor.name) })
      .finally(() => { materializing.delete(botId); });
    materializing.set(botId, run);
    return run;
  }

  function scheduleAuto(actor: CompanionRuntimeActor) {
    const botId = actor.externalId;
    if (materializing.has(botId) || Date.now() < (autoRetryAt.get(botId) ?? 0)) return;
    void materialize(actor).then(result => {
      autoRetryAt.delete(botId);
      input.log?.info?.('Companion moved to this computer', { actorId: actor.id, created: result.created, inserted: result.inserted, rebuild: result.rebuild });
      publish(); mirrors.kick(botId); uploads.kick(botId);
    }, error => {
      autoRetryAt.set(botId, Date.now() + AUTO_RETRY_MS);
      input.log?.warn('Companion take-over will retry', { actorId: actor.id, code: errorCode(error) });
    });
  }

  async function flush(botId: string) {
    const bot = input.bots().find(candidate => candidate.botId === botId);
    if (!bot) throw new Error('NOT_HOME');
    await uploader.syncBot(bot.botId, bot.actorId);
    await mirror.syncBot(bot.botId, bot.actorId, bot.name);
  }

  const runtime: CompanionCloudRuntime = {
    state,
    kickUploads: botId => uploads.kick(botId),
    kickMirror: botId => mirrors.kick(botId),
    roomIdFor: botId => state.bot(botId)?.roomId ?? null,
    isDirectRoom: roomId => state.botForRoom(roomId) !== null,
    syncNow: async () => { await uploads.run(); await mirrors.run(); },

    reconcile(localProfiles) {
      const self = input.selfDeviceId;
      if (!self || !live()) return;
      for (const actor of input.actors?.() ?? []) {
        if (actor.kind !== 'bot' || actor.disabled) continue;
        const botId = actor.externalId;
        const local = localProfiles.find(profile => profile.id === botId);
        const entry = state.bot(botId);
        if (actor.homeDeviceId && actor.homeDeviceId !== self) {
          if (local && local.status !== 'deleting' && !entry?.demoted) {
            state.update(botId, actor.id, next => { next.demoted = true; });
            input.log?.info?.('Companion now runs on another computer; local copy demoted', { actorId: actor.id });
          }
        } else if (actor.homeDeviceId === self && input.host.materializer) {
          // Handed here: the local copy was demoted, or this computer never ran it. A companion
          // deleted on its own home keeps its sync history and is not revived.
          const ranHere = !!entry?.mirror || entry?.prefsSeeded === true;
          if (entry?.demoted === true || (!local && !ranHere)) scheduleAuto(actor);
        }
      }
    },

    async takeOver(botId) {
      const self = input.selfDeviceId;
      if (!self || !live() || !input.host.materializer) return { ok: false, code: 'NOT_ENABLED' };
      let actor = actorOf(botId);
      if (!actor) {
        try { await input.refresh?.(); } catch (error) { return actionFailure(error); }
        actor = actorOf(botId);
      }
      if (!actor) return { ok: false, code: 'FAILED' };
      if (actor.homeDeviceId !== self) {
        try {
          await input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: self, expectedHomeDeviceId: actor.homeDeviceId ?? null });
        } catch (error) {
          const failure = actionFailure(error);
          if (!failure.ok && failure.code === 'HOME_CONFLICT') {
            actor.homeDeviceId = failure.homeDeviceId ?? null;
            await input.refresh?.().catch(() => undefined);
            publish();
          }
          return failure;
        }
        actor.homeDeviceId = self;
      }
      try {
        await materialize(actor);
      } catch (error) {
        input.log?.warn('Companion take-over could not finish locally', { actorId: actor.id, code: errorCode(error) });
        publish();
        return actionFailure(error);
      }
      publish(); mirrors.kick(actor.externalId); uploads.kick(actor.externalId);
      return { ok: true };
    },

    async transferTargets() {
      const devices = await input.host.listDevices?.().catch(() => []) ?? [];
      return devices.filter(isCompanionTransferTarget).map(device => ({ deviceId: device.deviceId, name: device.name, online: device.online }));
    },

    async transfer(botId, targetDeviceId) {
      const self = input.selfDeviceId;
      if (!self || !live()) return { ok: false, code: 'NOT_ENABLED' };
      const actor = actorOf(botId);
      if (!actor || actor.homeDeviceId !== self) return { ok: false, code: 'FAILED', homeDeviceId: actor?.homeDeviceId ?? null };
      if (!(await runtime.transferTargets()).some(device => device.deviceId === targetDeviceId)) return { ok: false, code: 'TARGET_UNAVAILABLE' };
      // Everything the new home needs must be on the server before the move.
      try { await flush(actor.externalId); }
      catch (error) {
        input.log?.warn('Companion hand-over stopped: sync did not finish', { actorId: actor.id, code: errorCode(error) });
        return actionFailure(error, 'OFFLINE');
      }
      try {
        await input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: targetDeviceId, expectedHomeDeviceId: self });
      } catch (error) {
        const failure = actionFailure(error);
        if (!failure.ok && failure.code === 'HOME_CONFLICT') await input.refresh?.().catch(() => undefined);
        return failure;
      }
      actor.homeDeviceId = targetDeviceId;
      state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
      publish();
      return { ok: true };
    },

    async transcript(botId, before) {
      const actor = actorOf(botId);
      if (!actor) throw new Error('COMPANION_NOT_FOUND');
      const roomId = await mirror.ensureRoom(actor.externalId, actor.id, actor.name);
      return readTranscriptPage(input.api, roomId, actor.id, before);
    },

    async retire(botId) {
      const self = input.selfDeviceId;
      const actor = actorOf(botId);
      // A demoted copy is not the companion: deleting it never touches the cloud.
      if (!self || !live() || !actor || actor.homeDeviceId !== self || state.isDemoted(botId)) return;
      await input.api(`/actors/${actor.id}`, 'PATCH', { disabled: true });
      actor.disabled = true;
      publish();
    },

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

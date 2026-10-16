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
import { COMPANION_PROFILE_KEY, COMPANION_VALUE_TOO_LARGE, createCompanionUploader, isCompanionProfileSnapshot, type CompanionPreferenceValue } from './uploader.js';

/** Electron/database side of the feature, wired in register.ts. */
export interface CompanionCloudHost {
  homes: CompanionHomeRegistry;
  openState: (endpoint: string, humanActorId: string, current: () => boolean) => CompanionCloudState;
  readValues: (botId: string) => Promise<CompanionPreferenceValue[]>;
  canonicalSession: (botId: string) => Promise<string | null>;
  rowsAfter: (sessionId: string, cursor: CompanionMirrorCursor, limit: number) => Promise<CompanionMirrorRow[]>;
  latestRows: (sessionId: string, limit: number, options?: { excludeClientIdPrefix?: string }) => Promise<CompanionMirrorRow[]>;
  /** Hand a room message to the companion's canonical Session as an ordinary user message. */
  deliverToCanonical: (botId: string, text: string, clientId: string) => Promise<{ ok: true } | { ok: false; errorCode: string }>;
  /** Local profile, memory, skill or canonical message change of a companion. */
  onLocalChange?: (listener: (botId: string) => void) => () => void;
  /** Local side of taking a companion over; absent disables take-over and auto-materialize. */
  materializer?: Omit<CompanionMaterializeHost, 'latestRows'>;
  /** The owner's devices from device-link. */
  listDevices?: () => Promise<DeviceLinkDeviceView[]>;
  /** Does that computer's Cindy support cloud companions (`maker:companion-cloud:caps`)? */
  probeCompanionCloud?: (deviceId: string) => Promise<boolean>;
  /** A turn is running (or queued) in any of the companion's tasks (main task, group lanes, delegations). */
  isBotBusy?: (botId: string) => Promise<boolean>;
  /** Random id of this Cindy installation (per userData); absent disables the install guard. */
  installationId?: () => string;
  /** Owner-scoped persisted shadow set (demotion survives restarts, an offline server and a disabled feature). */
  shadows?: { read: () => string[]; write: (ids: string[]) => void };
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
  /** The companion was deleted on its home (this computer): retire its cloud actor (retried until it succeeds). */
  retire: (botId: string) => Promise<void>;
  /** Demoted here, or homed on this device but owned by another Cindy installation. */
  isShadowed: (botId: string) => boolean;
  /** This installation is confirmed to run the companion (always true without an install guard). */
  installConfirmed: (botId: string) => boolean;
  /** Every shadowed local companion id (persisted by the caller). */
  shadowIds: () => string[];
  dispose: () => void;
}

/**
 * Bot preference naming the installation (and its device) that runs the companion. Another
 * installation on the same device defers to it; a record from another device means the
 * companion was handed here.
 */
export const COMPANION_INSTALL_KEY = 'companion.install.v1';
const INSTALL_RECHECK_MS = 2 * 60_000;

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

/** The home has uploaded the profile snapshot a take-over builds the companion from. */
export function hasProfileSnapshot(rows: unknown): boolean {
  const row = (Array.isArray(rows) ? rows : []).find((candidate: { key?: unknown }) => candidate?.key === COMPANION_PROFILE_KEY) as { value?: unknown } | undefined;
  return isCompanionProfileSnapshot(row?.value);
}

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
  /** Publish the companions' actor name and avatar now (they sync outside the preferences). */
  syncProfile?: (botId: string) => Promise<void>;
  log?: CompanionLog;
  uploadIntervalMs?: number;
  mirrorIntervalMs?: number;
  /** Run a first pass shortly after start (default). Harnesses drive passes explicitly. */
  initialKick?: boolean;
}): CompanionCloudRuntime {
  const state = input.host.openState(input.endpoint, input.humanActorId, input.current);
  const uploader = createCompanionUploader({ api: input.api, state, readValues: input.host.readValues, log: input.log,
    confirmHome: async (_botId, actorId) => {
      const actors = await input.api<CompanionRuntimeActor[]>('/actors');
      return actors.find(actor => actor.id === actorId)?.homeDeviceId === input.selfDeviceId;
    },
    onLostHome: () => { void input.refresh?.().catch(() => undefined); },
  });
  const mirror = createCompanionMirror({ api: input.api, state, humanActorId: () => input.humanActorId,
    canonicalSession: input.host.canonicalSession, rowsAfter: input.host.rowsAfter, latestRows: input.host.latestRows });
  let disposed = false;
  const live = () => !disposed && input.current();
  const aborts = new AbortController();
  /** Writes started by this account stop as soon as it is no longer current. */
  const fence = {
    assertCurrent: () => { if (!live()) throw new Error('OWNER_CHANGED'); },
    signal: aborts.signal,
  };
  // Install guard: which bots this installation runs ('mine'), another install on this device
  // runs ('other'), or another computer ran before handing them here ('handed').
  type InstallOwner = 'mine' | 'other' | 'handed';
  const installs = new Map<string, { owner: InstallOwner | 'pending'; checkedAt: number }>();
  const installId = input.host.installationId?.();
  const installOwner = (botId: string) => installId ? installs.get(botId)?.owner : 'mine';
  const pick = (only: Set<string> | null) => input.bots()
    .filter(bot => (!only || only.has(bot.botId)) && installOwner(bot.botId) === 'mine');
  const actorOf = (botId: string) => (input.actors?.() ?? []).find(a => a.kind === 'bot' && !a.disabled && (a.externalId === botId || a.id === botId));
  const publish = () => { if (live()) input.publish?.(); };

  function loop(run: (only: Set<string> | null) => Promise<void>, intervalMs: number, debounceMs: number) {
    let busy: Promise<void> | undefined;
    let queued: Only;
    let kicked: Only;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const hold = (work: Promise<unknown>): Promise<void> => {
      busy = work.then(() => undefined, () => undefined).finally(() => {
        busy = undefined;
        const next = queued; queued = undefined;
        if (next !== undefined) void fire(next);
      });
      return busy;
    };
    const fire = (only: Set<string> | null): Promise<void> => {
      if (!live()) return Promise.resolve();
      if (busy) { queued = union(queued, only); return busy; }
      return hold(run(only).catch(error => { input.log?.warn('Companion sync cycle failed', { code: errorCode(error) }); }));
    };
    const interval = setInterval(() => { void fire(null); }, intervalMs);
    interval.unref?.();
    return {
      run: () => fire(null),
      /** Run `task` once the cycle in flight is done; cycles started meanwhile wait for it. */
      async exclusive<T>(task: () => Promise<T>): Promise<T> {
        while (busy) await busy;
        const result = task();
        void hold(result);
        return result;
      },
      kick(botId?: string) {
        kicked = union(kicked, botId === undefined ? null : new Set([botId]));
        clearTimeout(debounce);
        debounce = setTimeout(() => { const only = kicked ?? null; kicked = undefined; void fire(only); }, debounceMs);
        debounce.unref?.();
      },
      dispose() { clearInterval(interval); clearTimeout(debounce); },
    };
  }

  const uploads = loop(async only => {
    // A first-upgrade burst is spread over cycles; continue soon when the budget ran out.
    if (await uploader.syncAll(pick(only))) uploads.kick();
  }, input.uploadIntervalMs ?? 60_000, 15_000);
  const mirrors = loop(async only => {
    for (const bot of pick(only)) {
      if (!live()) return;
      try {
        if (state.bot(bot.botId)?.pendingRebuild && input.host.materializer) {
          const sessionId = await input.host.canonicalSession(bot.botId);
          if (sessionId) await rebuildPending({ state, host: input.host.materializer, botId: bot.botId, actorId: bot.actorId, sessionId, fence });
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
    const run = materializeCompanion({ api: input.api, state, log: input.log, fence, onDemoted: publish, host: { ...materializer, latestRows: input.host.latestRows },
      actor: { id: actor.id, externalId: botId, name: actor.name, avatar: actor.avatar ?? null },
      roomId: () => mirror.ensureRoom(botId, actor.id, actor.name) })
      .finally(() => { materializing.delete(botId); });
    materializing.set(botId, run);
    return run;
  }

  /**
   * Record that this installation runs the companion. `check` only claims an empty record;
   * `handed` (automatic take-over) also replaces another computer's record, never another
   * installation's claim on this computer; `takeover` (the user's explicit take-over) replaces any.
   */
  async function claimInstall(actor: CompanionRuntimeActor, mode: 'check' | 'handed' | 'takeover'): Promise<InstallOwner> {
    if (!installId) return 'mine';
    const rows = await input.api<Array<{ key: string; value: unknown; revision: number }>>('/preferences', 'GET', undefined, actor.id);
    const row = (Array.isArray(rows) ? rows : []).find(candidate => candidate.key === COMPANION_INSTALL_KEY);
    const record = row?.value && typeof row.value === 'object' ? row.value as { installationId?: unknown; deviceId?: unknown } : {};
    const current = record.installationId;
    let owner: InstallOwner = current === installId ? 'mine'
      : typeof record.deviceId === 'string' && record.deviceId !== input.selfDeviceId ? 'handed' : 'other';
    // A hand-over is completed by the take-over (which overwrites), never by this check.
    if ((owner === 'other' && (mode === 'takeover' || typeof current !== 'string')) || (owner === 'handed' && mode !== 'check')) {
      try {
        await input.api('/preferences', 'POST', { operationId: `cinstall:${actor.id}:${installId}:${row?.revision ?? 0}`,
          key: COMPANION_INSTALL_KEY, expectedRevision: row?.revision ?? 0,
          value: { installationId: installId, ...(input.selfDeviceId ? { deviceId: input.selfDeviceId } : {}) } }, actor.id);
        owner = 'mine';
      } catch (error) {
        // Another installation on this device claimed it first.
        if (!chatRejection(error, 409, 'REVISION_CONFLICT')) throw error;
      }
    }
    installs.set(actor.externalId, { owner, checkedAt: Date.now() });
    return owner;
  }

  function checkInstall(actor: CompanionRuntimeActor) {
    if (!installId) return;
    const known = installs.get(actor.externalId);
    if (known && Date.now() - known.checkedAt < INSTALL_RECHECK_MS) return;
    installs.set(actor.externalId, { owner: known?.owner ?? 'pending', checkedAt: Date.now() });
    void claimInstall(actor, 'check').then(owner => {
      // Handed here before this computer ever saw the move: take the existing copy over.
      if (owner === 'handed' && input.host.materializer) scheduleAuto(actor);
      if (owner !== known?.owner) { publish(); uploads.kick(actor.externalId); mirrors.kick(actor.externalId); }
    }, error => {
      installs.delete(actor.externalId);
      input.log?.warn('Companion installation check will retry', { actorId: actor.id, code: errorCode(error) });
    });
  }

  /** Hide and stop the local copy now (materialize lifts it once the take-over completes). */
  function demoteNow(actor: CompanionRuntimeActor) {
    if (state.isDemoted(actor.externalId)) return;
    state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
    publish();
  }

  function scheduleAuto(actor: CompanionRuntimeActor) {
    const botId = actor.externalId;
    if (materializing.has(botId) || Date.now() < (autoRetryAt.get(botId) ?? 0)) return;
    autoRetryAt.set(botId, Date.now() + AUTO_RETRY_MS);
    // Hidden first, through the home confirmation and the claim: the stale copy must not run or sync
    // meanwhile. The take-over lifts it once complete; a failure keeps it hidden and retries.
    demoteNow(actor);
    // Confirm the home with the server before un-demoting: a stale actor cache must not
    // resurrect a copy whose companion has already moved on.
    void input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: input.selfDeviceId })
      .then(async () => {
        // Automatic: never take the companion from the other installation on this computer.
        if (await claimInstall(actor, 'handed') !== 'mine') throw new Error('INSTALL_CLAIM_LOST');
        return materialize(actor);
      }).then(result => {
      autoRetryAt.delete(botId);
      input.log?.info?.('Companion moved to this computer', { actorId: actor.id, created: result.created, inserted: result.inserted, rebuild: result.rebuild });
      publish(); mirrors.kick(botId); uploads.kick(botId);
    }, error => {
      autoRetryAt.set(botId, Date.now() + AUTO_RETRY_MS);
      if (chatRejection(error, 409, 'HOME_DEVICE_CONFLICT')) { void input.refresh?.().catch(() => undefined); return; }
      input.log?.warn('Companion take-over will retry', { actorId: actor.id, code: errorCode(error) });
    });
  }

  /** Retire only from the installation that may run it: another Cindy on this computer may own it. */
  async function retireOwned(actor: CompanionRuntimeActor) {
    let owner = installOwner(actor.externalId);
    // Not confirmed yet (pending, failed, or just handed here): claim it the way the automatic
    // take-over does, so only one installation on this computer can win; a failure retries later.
    if (owner !== 'mine' && owner !== 'other') owner = await claimInstall(actor, 'handed');
    if (owner !== 'mine') {
      state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
      return;
    }
    await retireActor(actor);
  }

  async function retireActor(actor: CompanionRuntimeActor) {
    // Compare-and-set on the home: if another computer took the companion over meanwhile, this
    // was only a copy, and deleting it never retires the companion itself.
    try {
      await input.api(`/actors/${actor.id}`, 'PATCH', { disabled: true, homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: input.selfDeviceId });
    } catch (error) {
      const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
      if (!conflict) throw error;
      actor.homeDeviceId = typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null;
      state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
      void input.refresh?.().catch(() => undefined);
      publish();
      return;
    }
    actor.disabled = true;
    state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
    publish();
  }

  async function flush(botId: string) {
    const bot = pick(null).find(candidate => candidate.botId === botId);
    if (!bot) throw new Error('NOT_HOME');
    // The whole conversation backlog first: the old copy stops mirroring once demoted, and a long
    // drain must not leave edits made meanwhile behind.
    await mirror.syncBot(bot.botId, bot.actorId, bot.name, { drain: true });
    // Every portable value must reach the server: a skipped one would be lost by the move. Repeat
    // until a pass writes nothing, so the move starts from what is on disk right now.
    for (let pass = 0; ; pass += 1) {
      if (await uploader.syncBot(bot.botId, bot.actorId, Number.POSITIVE_INFINITY, { requireAll: true }) === 0) break;
      if (pass >= 2) throw new Error('COMPANION_STILL_CHANGING');
    }
    // The actor's name and avatar too: once demoted, this copy may no longer publish them.
    await input.syncProfile?.(bot.botId);
  }

  /** Everything the new home needs reaches the server, then the home moves and this copy is demoted. */
  async function handOver(actor: CompanionRuntimeActor, targetDeviceId: string): Promise<CompanionCloudActionResult> {
    // A running turn would keep working here (tools, files, replies) after the target took over.
    const turnActive = async () => !!(await input.host.isBotBusy?.(actor.externalId));
    if (await turnActive()) return { ok: false, code: 'BUSY' };
    try { await flush(actor.externalId); }
    catch (error) {
      input.log?.warn('Companion hand-over stopped: sync did not finish', { actorId: actor.id, code: errorCode(error) });
      const code = errorCode(error);
      return [COMPANION_VALUE_TOO_LARGE, 'COMPANION_STILL_CHANGING', 'INVALID_AVATAR', 'AVATAR_UPLOAD_FAILED'].includes(code)
        ? { ok: false, code: 'FAILED' } : actionFailure(error, 'OFFLINE');
    }
    // Checked again right before the move: a turn may have started during the flush.
    if (await turnActive()) return { ok: false, code: 'BUSY' };
    try {
      await input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: targetDeviceId, expectedHomeDeviceId: input.selfDeviceId });
    } catch (error) {
      const failure = actionFailure(error);
      if (!failure.ok && failure.code === 'HOME_CONFLICT') await input.refresh?.().catch(() => undefined);
      return failure;
    }
    actor.homeDeviceId = targetDeviceId;
    state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
    publish();
    return { ok: true };
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
        if (actor.kind !== 'bot') continue;
        const botId = actor.externalId;
        const local = localProfiles.find(profile => profile.id === botId);
        const entry = state.bot(botId);
        if (actor.disabled) {
          // Deleted on its main computer (perhaps while this one was offline): a copy here is no
          // longer the companion, so it is hidden and stopped like any other old copy.
          if (local && local.status !== 'deleting' && !entry?.demoted) {
            state.update(botId, actor.id, next => { next.demoted = true; });
            input.log?.info?.('Companion was deleted on its main computer; local copy demoted', { actorId: actor.id });
          }
          continue;
        }
        if (entry?.retirePending && actor.homeDeviceId !== self) {
          // Another computer took the companion over before the retry: the deletion here only
          // removed a copy (as with HOME_DEVICE_CONFLICT), and must not retire it if handed back.
          state.update(botId, actor.id, next => { delete next.retirePending; });
        } else if (entry?.retirePending) {
          if (Date.now() >= (autoRetryAt.get(`retire:${botId}`) ?? 0)) {
            autoRetryAt.set(`retire:${botId}`, Date.now() + AUTO_RETRY_MS);
            void retireOwned(actor).catch(error => input.log?.warn('Companion retire will retry', { actorId: actor.id, code: errorCode(error) }));
          }
          continue;
        }
        if (actor.homeDeviceId === self && local) checkInstall(actor);
        if (actor.homeDeviceId && actor.homeDeviceId !== self) {
          if (local && local.status !== 'deleting' && !entry?.demoted) {
            state.update(botId, actor.id, next => { next.demoted = true; });
            input.log?.info?.('Companion now runs on another computer; local copy demoted', { actorId: actor.id });
          }
        } else if (actor.homeDeviceId === self && input.host.materializer) {
          // Handed here: the local copy was demoted, or this computer never ran it. A companion
          // deleted on its own home keeps its sync history and is not revived.
          const ranHere = !!entry?.mirror || entry?.prefsSeeded === true;
          if (installOwner(botId) !== 'other' && (entry?.demoted === true || (!local && !ranHere))) scheduleAuto(actor);
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
      // Never move the home before the companion's profile snapshot is in the cloud: without it
      // this copy could not be built, and the old home would already be demoted.
      try {
        const rows = await input.api<Array<{ key: string; value: unknown }>>('/preferences', 'GET', undefined, actor.id);
        if (!hasProfileSnapshot(rows)) return { ok: false, code: 'FAILED' };
      } catch (error) { return actionFailure(error); }
      // Always compare-and-set, even when the cached home already says "here": the cache may be
      // stale (another computer took over while this one was offline). Unchanged homes are a no-op.
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
      try {
        // Taking over from this installation also takes it from another install on the same device.
        demoteNow(actor);
        if (await claimInstall(actor, 'takeover') !== 'mine') return { ok: false, code: 'FAILED' };
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
      const devices = (await input.host.listDevices?.().catch(() => []) ?? []).filter(isCompanionTransferTarget);
      // Older Cindy versions cannot take a companion over: never strand one there.
      const probe = input.host.probeCompanionCloud;
      const supported = probe ? await Promise.all(devices.map(device => probe(device.deviceId).catch(() => false))) : devices.map(() => true);
      return devices.filter((_device, index) => supported[index])
        .map(device => ({ deviceId: device.deviceId, name: device.name, online: device.online }));
    },

    async transfer(botId, targetDeviceId) {
      const self = input.selfDeviceId;
      if (!self || !live()) return { ok: false, code: 'NOT_ENABLED' };
      const actor = actorOf(botId);
      if (!actor || actor.homeDeviceId !== self) return { ok: false, code: 'FAILED', homeDeviceId: actor?.homeDeviceId ?? null };
      const devices = await input.host.listDevices?.().catch(() => []) ?? [];
      const target = devices.find(device => device.deviceId === targetDeviceId && isCompanionTransferTarget(device));
      const probe = input.host.probeCompanionCloud;
      if (!target || (probe && !(await probe(targetDeviceId).catch(() => false)))) return { ok: false, code: 'TARGET_UNAVAILABLE' };
      // No background cycle may write in between: one already in flight could carry older values
      // past the flush, or past the move. Background sync resumes after the copy is demoted.
      return mirrors.exclusive(() => uploads.exclusive(() => handOver(actor, targetDeviceId)));
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
      if (!self || !live() || !actor || actor.homeDeviceId !== self || runtime.isShadowed(botId)) return;
      state.update(botId, actor.id, entry => { entry.retirePending = true; });
      await retireOwned(actor);
    },

    isShadowed: botId => state.isDemoted(botId) || installOwner(botId) === 'other',
    installConfirmed: botId => installOwner(botId) === 'mine',
    shadowIds: () => [...new Set([...state.demotedBotIds(),
      ...[...installs].flatMap(([botId, value]) => value.owner === 'other' ? [botId] : [])])].sort(),

    dispose() {
      disposed = true;
      aborts.abort();
      uploads.dispose(); mirrors.dispose(); unsubscribe?.();
      if (active === runtime) active = null;
    },
  };
  active = runtime;
  // First pass soon after start; later passes follow the intervals and local changes.
  if (input.initialKick !== false) { uploads.kick(); mirrors.kick(); }
  return runtime;
}

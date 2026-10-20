/** Subscription snapshots used for group eligibility and balancing, never credentials or token estimates. */
import {
  matchScopedWindowForModel,
  type ClaudeSubscriptionUsageSnapshot,
  type ClaudeUsageWindow,
} from '@cindy/maker-shared/subscription-usage';

import { codexLimitBucketKey, matchCodexBucketForModel, resolveCodexBucketTable } from '@cindy/maker-shared/codex-usage-buckets';
import { accountUsageLimitFromWindows, claudeAccountUsageLimit } from '../../shared/accountUsageLimit.js';
import type { ProviderGroupMember } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';

export const PROVIDER_GROUP_USAGE_MAX_AGE_MS = 10 * 60_000;
export const PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS = 1_500;
const REMOTE_USAGE_CACHE_MS = 15_000;
const MAX_CACHED_ACCOUNTS = 512;

interface CodexUsageWindow {
  usedPercent?: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

interface CodexUsageBucket {
  limitId: string | null;
  limitName: string | null;
  updatedAt: number | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
}

/** Only quota fields survive parsing; account identity and reset-credit offers stay out of the directory. */
export interface ProviderGroupCodexUsageSnapshot {
  appServerBuckets: Record<string, CodexUsageBucket> | null;
  webSnapshot: CodexUsageBucket | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function currentSnapshot(updatedAt: unknown, now: number): boolean {
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0
    && now - updatedAt <= PROVIDER_GROUP_USAGE_MAX_AGE_MS && updatedAt - now <= 60_000;
}

function codexWindow(raw: unknown): CodexUsageWindow | null {
  if (raw === undefined || raw === null) return null;
  const value = record(raw);
  return {
    usedPercent: typeof value?.usedPercent === 'number' && Number.isFinite(value.usedPercent) && value.usedPercent >= 0
      ? Math.min(100, value.usedPercent) : undefined,
    windowMinutes: typeof value?.windowMinutes === 'number' && Number.isFinite(value.windowMinutes) && value.windowMinutes > 0
      ? value.windowMinutes : null,
    resetsAt: typeof value?.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}

function codexBucket(raw: unknown): CodexUsageBucket | null {
  const value = record(raw);
  if (!value) return null;
  return {
    limitId: typeof value.limitId === 'string' ? value.limitId : null,
    limitName: typeof value.limitName === 'string' ? value.limitName : null,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
    primary: codexWindow(value.primary), secondary: codexWindow(value.secondary),
  };
}

export function providerGroupCodexUsageSnapshot(raw: unknown): ProviderGroupCodexUsageSnapshot | null {
  const value = record(raw);
  if (!value) return null;
  const table = resolveCodexBucketTable({ appServerBuckets: value.appServerBuckets });
  const fallback = value.source !== 'openai-web' && (value.primary || value.secondary) ? codexBucket(value) : null;
  const appServerBuckets = table
    ? Object.fromEntries(Object.entries(table).map(([key, bucket]) => [key, codexBucket(bucket)!]))
    : fallback ? { [codexLimitBucketKey(fallback)]: fallback } : null;
  const webSnapshot = codexBucket(value.webSnapshot ?? (value.source === 'openai-web' ? value : null));
  return appServerBuckets || webSnapshot ? { appServerBuckets, webSnapshot } : null;
}

/** A completed account/rateLimits/read is fresh; cached account payloads retain each bucket's own timestamp. */
export function providerGroupCodexUsageFromReads(account: unknown, rateLimits: unknown, now: number) {
  const cached = providerGroupCodexUsageSnapshot(account);
  const result = record(rateLimits);
  const latest = record(result?.rateLimits);
  if (!latest) return cached;
  const table = resolveCodexBucketTable({ byLimitId: result?.rateLimitsByLimitId })
    ?? { [codexLimitBucketKey(latest)]: latest };
  return providerGroupCodexUsageSnapshot({
    appServerBuckets: Object.fromEntries(Object.entries(table).map(([key, bucket]) => [key, { ...bucket, updatedAt: now }])),
    webSnapshot: cached?.webSnapshot,
  });
}

/** Select a model's own bucket before checking age: fresh unrelated buckets cannot refresh it. */
function codexUsageState(snapshot: ProviderGroupCodexUsageSnapshot, model: string | null | undefined, now: number, agentKind?: string) {
  const bucket = (agentKind !== undefined && agentKind !== 'codex') || model?.startsWith('chatgpt/')
    ? snapshot.webSnapshot : matchCodexBucketForModel(snapshot.appServerBuckets, model, now);
  if (!bucket || !currentSnapshot(bucket.updatedAt, now)) return providerGroupUsageState(null, model, now);
  const windows = [bucket.primary, bucket.secondary].filter((w): w is CodexUsageWindow => w !== null);
  const limit = accountUsageLimitFromWindows(windows.flatMap((w) => w.usedPercent === undefined
    ? [] : [{ usedPercent: w.usedPercent, resetsAtSec: w.resetsAt }]), now);
  const current = (w: CodexUsageWindow) => w.usedPercent !== undefined && (!w.resetsAt || w.resetsAt * 1000 > now);
  const usagePercent = windows.length > 0 && windows.every(current) ? Math.max(...windows.map((w) => w.usedPercent!)) : null;
  const unusedUntil = (minutes: number) => {
    const w = windows.find((w) => w.windowMinutes === minutes);
    return w && w.usedPercent !== undefined && w.usedPercent < 100 && w.resetsAt && w.resetsAt * 1000 > now ? w.resetsAt * 1000 : null;
  };
  return { ...limit, usagePercent, weeklyResetAtMs: unusedUntil(10_080), fiveHourResetAtMs: unusedUntil(300) };
}

export function providerGroupMemberUsageState(
  member: { claudeUsage?: ClaudeSubscriptionUsageSnapshot | null; codexUsage?: ProviderGroupCodexUsageSnapshot | null },
  model: string | null | undefined,
  now: number,
  agentKind?: string,
) {
  return member.codexUsage ? codexUsageState(member.codexUsage, model, now, agentKind) : providerGroupUsageState(member.claudeUsage, model, now);
}

function windowOf(raw: unknown): ClaudeUsageWindow | null {
  const value = record(raw);
  if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0) return null;
  return {
    utilization: Math.min(100, value.utilization),
    resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}

/** Old/malformed snapshots are unknown, not a claim of zero usage or a permanent cooldown. */
export function providerGroupUsageSnapshot(raw: unknown, now: number): ClaudeSubscriptionUsageSnapshot | null {
  const value = record(raw);
  if (!value || !currentSnapshot(value.updatedAt, now)) return null;
  return {
    updatedAt: value.updatedAt as number,
    fiveHour: windowOf(value.fiveHour),
    sevenDay: windowOf(value.sevenDay),
    scoped: (Array.isArray(value.scoped) ? value.scoped : []).flatMap((rawWindow) => {
      const item = record(rawWindow);
      const window = windowOf(rawWindow);
      if (!window || typeof item?.modelDisplayName !== 'string') return [];
      return [{ ...window, modelDisplayName: item.modelDisplayName, modelId: typeof item.modelId === 'string' ? item.modelId : null }];
    }),
    rateLimitStatus: typeof value.rateLimitStatus === 'string' ? value.rateLimitStatus : null,
    representativeClaim: typeof value.representativeClaim === 'string' ? value.representativeClaim : null,
  };
}

/** Check exhaustion first. A score requires both current windows, so missing data cannot win as 0%. */
export function providerGroupUsageState(raw: unknown, model: string | null | undefined, now: number) {
  const snapshot = providerGroupUsageSnapshot(raw, now);
  const limit = claudeAccountUsageLimit(snapshot, model, now);
  const current = (w: ClaudeUsageWindow | null | undefined) =>
    w && (!w.resetsAt || w.resetsAt * 1000 > now) ? w.utilization : null;
  const fiveHour = current(snapshot?.fiveHour);
  const sevenDay = current(snapshot?.sevenDay);
  const scoped = matchScopedWindowForModel(snapshot?.scoped, model);
  const scopedUsage = current(scoped);
  const usagePercent = fiveHour !== null && sevenDay !== null && (!scoped || scopedUsage !== null)
    ? Math.max(fiveHour, sevenDay, scopedUsage ?? 0) : null;
  // Quota left in a window is lost when it resets; only a known future reset with quota left can be "expiring".
  const unusedUntil = (w: ClaudeUsageWindow | null | undefined) =>
    w?.resetsAt && w.resetsAt * 1000 > now && w.utilization < 100 ? w.resetsAt * 1000 : null;
  return {
    limited: limit?.limited ?? false,
    resetAtMs: limit?.resetAtMs ?? null,
    usagePercent,
    weeklyResetAtMs: unusedUntil(snapshot?.sevenDay),
    fiveHourResetAtMs: unusedUntil(snapshot?.fiveHour),
  };
}

export interface ProviderGroupUsageReaderDeps<T> {
  readLocal(providerId: string): Promise<unknown>;
  readRemote(deviceId: string, providerId: string): Promise<unknown>;
  isCurrent(): boolean;
  now(): number;
  parseSnapshot(raw: unknown, now: number): T | null;
  cacheLocal?: boolean;
}

/** Per-owner, bounded remote reads. A slow/old peer cannot stall routing or multiply in-flight requests. */
export function createProviderGroupUsageReader<T>(deps: ProviderGroupUsageReaderDeps<T>) {
  const cached = new Map<string, { at: number; snapshot: T | null }>();
  const pending = new Map<string, Promise<T | null>>();

  async function bounded(promise: Promise<T | null>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Completed sources remain usable when a caller's overall deadline precedes a sibling read's timeout. */
    peek(member: ProviderGroupMember): T | null {
      if (!deps.isCurrent() || member.kind === 'share'
        || (member.agentDeviceId && isProviderShareAgentDeviceId(member.agentDeviceId))
        || (member.kind === 'local' && !deps.cacheLocal)) return null;
      const previous = cached.get(JSON.stringify([member.agentDeviceId, member.providerId]));
      return previous && deps.now() - previous.at < REMOTE_USAGE_CACHE_MS
        ? deps.parseSnapshot(previous.snapshot, deps.now()) : null;
    },
    async read(member: ProviderGroupMember): Promise<T | null> {
      if (!deps.isCurrent() || member.kind === 'share'
        || (member.agentDeviceId && isProviderShareAgentDeviceId(member.agentDeviceId))) return null;
      const key = JSON.stringify([member.agentDeviceId, member.providerId]);
      const previous = cached.get(key);
      if ((member.kind !== 'local' || deps.cacheLocal) && previous && deps.now() - previous.at < REMOTE_USAGE_CACHE_MS) {
        return deps.parseSnapshot(previous.snapshot, deps.now());
      }
      let request = pending.get(key);
      if (!request) {
        if (pending.size >= MAX_CACHED_ACCOUNTS) return null;
        request = Promise.resolve().then(async () => {
          if (!deps.isCurrent()) return null;
          const raw = member.kind === 'local'
            ? await deps.readLocal(member.providerId)
            : await deps.readRemote(member.agentDeviceId!, member.providerId);
          return deps.isCurrent() ? deps.parseSnapshot(raw, deps.now()) : null;
        }).catch(() => null).then((snapshot) => {
          pending.delete(key);
          if (deps.isCurrent() && (member.kind !== 'local' || deps.cacheLocal)) {
            if (cached.size >= MAX_CACHED_ACCOUNTS) cached.delete(cached.keys().next().value!);
            cached.set(key, { at: deps.now(), snapshot });
          }
          return snapshot;
        });
        pending.set(key, request);
      }
      const snapshot = await bounded(request);
      return deps.isCurrent() ? deps.parseSnapshot(snapshot, deps.now()) : null;
    },
    invalidate() { cached.clear(); },
  };
}

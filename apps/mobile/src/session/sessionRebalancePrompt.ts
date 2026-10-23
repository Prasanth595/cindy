/**
 * 任务进行中换号(provider-groups.md §6.2)：上一轮结束后，任务所在电脑提议为了均匀用完各账号的配额换一个账号时，
 * 手机在输入框上方放一行轻提示「{label} 的配额更该先用（还剩 80%，…后重置）」+「切换」+ ×，不弹窗、不拦发送。
 * - 什么都不做：照常用当前账号发，下一条消息也不会被问。
 * - 点「切换」：只是记下「下一条换过去」，提示改成「下一条消息会换到 {label} 继续」+「撤销」；真正发送那一刻才把
 *   决定记到任务所在电脑(`rebalance-decision`，remember 恒为 false)，等它记好再发这条消息。
 * - 点 ×：提示立即消失，顺手告诉任务所在电脑(`rebalance-decline`，不等回包、旧版本报错也不管)，它在配额窗口重置前
 *   不再为这个任务提议；手机本地也在同一时间内不再显示这条提议，免得旧版本电脑下一次预取又把它带回来。
 * - 组开了自动均衡(或任务旧的「以后自动换」设置)时回包是 auto：不显示提示，发送时直接记下换号。
 *
 * 判断和记录都在任务所在电脑(`provider-group:remote`)。点发送要立刻清空输入框、不等网络往返，所以提议在任务空闲时
 * 预先问好(上一轮结束、打开任务时，空闲期间每 5 分钟再问)，存进可订阅的小仓库供提示渲染；一次提议最多用于一条消息，
 * 发送时取走。没问到、问不到、旧版本不认识这个请求都按不提议处理。
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { i18n } from '@/i18n';

import { formatLocalizedSeconds } from './sessionDurationFormat';

/** 预先问一次的上限：问不到就当没有提议。 */
export const SESSION_REBALANCE_QUERY_TIMEOUT_MS = 5_000;
/** 问到的提议多久内可用：与组所在电脑判断配额用的快照有效期一致。 */
export const SESSION_REBALANCE_CACHE_MS = 10 * 60_000;
/** 任务空闲、开着时多久重新问一次。 */
export const SESSION_REBALANCE_REFRESH_MS = 5 * 60_000;
const MAX_PREFETCHED = 100;

// 与桌面端 shared/providerGroup.ts 读这个回包的口径一致。
const MEMBER_KEY = /^[A-Za-z0-9_.:-]{1,300}$/;
// eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_WINDOW_MS = 31 * 86_400_000;
const MAX_REBALANCE_LABEL_LENGTH = 128 * 2 + 3;

export interface MobileRebalanceSuggestion {
  kind: 'ask' | 'auto';
  memberKey: string;
  label: string;
  quota: { usedPercent: number; resetAtMs: number | null; windowMs: number };
}

type Invoke = (deviceId: string, channel: string, args?: unknown[]) => Promise<unknown>;

interface PrefetchedEntry {
  at: number;
  suggestion: MobileRebalanceSuggestion | null;
  /** 用户点了「切换」：下一条消息发送时换过去。 */
  armed: boolean;
}

// 每个任务一条问好的提议；条目整体替换，订阅方按引用判断变化。
const prefetched = new Map<string, PrefetchedEntry>();
const inFlight = new Set<string>();
// 每次取走 / 关掉提议都递增：在此之前发出的预取回来时作废，免得把刚处理掉的提议又带回来。
const generations = new Map<string, number>();
// 用户点 × 后到什么时候前不再显示这个任务的提议(对齐任务所在电脑的暂停；旧版本电脑不认 decline 时靠它)。
const declinedUntil = new Map<string, number>();
const listeners = new Set<() => void>();

function cacheKey(hostDeviceId: string, sessionId: string): string {
  return `${hostDeviceId}\u0000${sessionId}`;
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bumpGeneration(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  if (generations.size > MAX_PREFETCHED) generations.delete(generations.keys().next().value!);
}

function setEntry(key: string, entry: PrefetchedEntry | null): void {
  prefetched.delete(key);
  if (entry) prefetched.set(key, entry);
  if (prefetched.size > MAX_PREFETCHED) prefetched.delete(prefetched.keys().next().value!);
  emit();
}

function isFresh(entry: PrefetchedEntry | undefined | null, nowMs = Date.now()): entry is PrefetchedEntry {
  return !!entry && nowMs - entry.at <= SESSION_REBALANCE_CACHE_MS;
}
/** 读 `rebalance-suggestion` 的回包；格式不对按不提议处理。 */
export function parseMobileRebalanceSuggestion(raw: unknown): MobileRebalanceSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'ask' && value.kind !== 'auto') return null;
  if (typeof value.memberKey !== 'string' || !MEMBER_KEY.test(value.memberKey)) return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const quota = value.quota as Record<string, unknown> | null | undefined;
  if (!label || label.length > MAX_REBALANCE_LABEL_LENGTH || CONTROL_CHARS.test(label) || !quota || typeof quota !== 'object') return null;
  const { usedPercent, resetAtMs, windowMs } = quota;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_WINDOW_MS) return null;
  if (resetAtMs !== null && (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs) || resetAtMs <= 0)) return null;
  return {
    kind: value.kind,
    memberKey: value.memberKey,
    label,
    quota: { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetAtMs, windowMs },
  };
}

/** 配额那半句：还剩多少、多久重置。 */
export function describeMobileRebalanceQuota(suggestion: MobileRebalanceSuggestion, nowMs = Date.now()): string {
  const left = Math.max(0, Math.round(100 - suggestion.quota.usedPercent));
  const remainingMs = suggestion.quota.resetAtMs === null ? null : suggestion.quota.resetAtMs - nowMs;
  return remainingMs !== null && remainingMs > 0
    ? i18n.t('session.providerGroupRebalance.quotaReset', {
        left,
        reset: formatLocalizedSeconds(Math.ceil(remainingMs / 60_000) * 60),
      })
    : i18n.t('session.providerGroupRebalance.quota', { left });
}

/** 输入框上方那一行：没点切换时说哪个账号更该先用，点了以后说下一条会换过去。 */
export function describeMobileRebalanceHint(
  suggestion: MobileRebalanceSuggestion,
  armed: boolean,
  nowMs = Date.now(),
): string {
  return armed
    ? i18n.t('session.providerGroupRebalance.armed', { label: suggestion.label })
    : i18n.t('session.providerGroupRebalance.hint', {
        label: suggestion.label,
        quota: describeMobileRebalanceQuota(suggestion, nowMs),
      });
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SESSION_REBALANCE_QUERY_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 任务空闲时预先问好提议。同一个任务同时只问一次。 */
export async function prefetchMobileSessionRebalance(invoke: Invoke, hostDeviceId: string, sessionId: string): Promise<void> {
  const key = cacheKey(hostDeviceId, sessionId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const generation = generations.get(key) ?? 0;
  try {
    const raw = await withTimeout(
      invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-suggestion', sessionId }]),
      null,
    );
    // 问的途中用户已经发出消息或关掉了提示：这份回包是旧的。
    if ((generations.get(key) ?? 0) !== generation) return;
    const now = Date.now();
    let suggestion = parseMobileRebalanceSuggestion(raw);
    const until = declinedUntil.get(key);
    if (until !== undefined && until <= now) declinedUntil.delete(key);
    if (suggestion?.kind === 'ask' && until !== undefined && until > now) suggestion = null;
    const previous = prefetched.get(key);
    // 重新问到的还是同一个账号时保留「切换」，换了账号或不再提议时作废。
    const armed = !!suggestion && suggestion.kind === 'ask' && !!previous?.armed
      && previous.suggestion?.memberKey === suggestion.memberKey;
    setEntry(key, { at: now, suggestion, armed });
  } finally {
    inFlight.delete(key);
  }
}

export interface MobileRebalanceHint {
  suggestion: MobileRebalanceSuggestion;
  armed: boolean;
}

/** 当前任务要不要在输入框上方显示换号提示；只有 ask 类、没过期的提议才显示。 */
export function readMobileSessionRebalanceHint(hostDeviceId: string, sessionId: string, nowMs = Date.now()): MobileRebalanceHint | null {
  const entry = prefetched.get(cacheKey(hostDeviceId, sessionId));
  if (!isFresh(entry, nowMs) || entry.suggestion?.kind !== 'ask') return null;
  return { suggestion: entry.suggestion, armed: entry.armed };
}

/** 点「切换」/「撤销」：只改本地，真正换号在下一条消息发送时记到任务所在电脑。 */
export function armMobileSessionRebalance(hostDeviceId: string, sessionId: string, armed: boolean): void {
  const key = cacheKey(hostDeviceId, sessionId);
  const entry = prefetched.get(key);
  if (!isFresh(entry) || entry.suggestion?.kind !== 'ask' || entry.armed === armed) return;
  setEntry(key, { ...entry, armed });
}

/**
 * 点 ×：立即收起，并告诉任务所在电脑这个任务先别再提议(不等回包；旧版本电脑回
 * `[INVALID_PARAMS] unknown provider group action` 也不管)。本地同样在配额重置前不再显示。
 */
export function dismissMobileSessionRebalance(invoke: Invoke, hostDeviceId: string, sessionId: string): void {
  const key = cacheKey(hostDeviceId, sessionId);
  const entry = prefetched.get(key);
  const now = Date.now();
  const resetAtMs = entry?.suggestion?.quota.resetAtMs ?? null;
  declinedUntil.delete(key);
  declinedUntil.set(key, resetAtMs !== null && resetAtMs > now ? resetAtMs : now + SESSION_REBALANCE_CACHE_MS);
  if (declinedUntil.size > MAX_PREFETCHED) declinedUntil.delete(declinedUntil.keys().next().value!);
  bumpGeneration(key);
  setEntry(key, null);
  void invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-decline', sessionId }]).catch(() => undefined);
}

/**
 * 开着的任务空闲且连着时预先问好提议：变空闲(上一轮结束、打开任务)时问一次，之后每 5 分钟再问。
 * 返回输入框上方要显示的提示(没有就是 null)和它的三个操作。
 */
export function useMobileSessionRebalancePrefetch(input: {
  invoke: Invoke;
  hostDeviceId: string;
  sessionId: string;
  idle: boolean;
}): {
  hint: MobileRebalanceHint | null;
  arm(): void;
  undo(): void;
  dismiss(): void;
} {
  const { invoke, hostDeviceId, sessionId, idle } = input;
  useEffect(() => {
    if (!hostDeviceId || !sessionId || !idle) return;
    void prefetchMobileSessionRebalance(invoke, hostDeviceId, sessionId);
    const timer = setInterval(
      () => void prefetchMobileSessionRebalance(invoke, hostDeviceId, sessionId),
      SESSION_REBALANCE_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [invoke, hostDeviceId, sessionId, idle]);
  const key = cacheKey(hostDeviceId, sessionId);
  const getSnapshot = useCallback(() => prefetched.get(key) ?? null, [key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const hint = useMemo<MobileRebalanceHint | null>(
    () => (isFresh(entry) && entry.suggestion?.kind === 'ask' ? { suggestion: entry.suggestion, armed: entry.armed } : null),
    [entry],
  );
  const arm = useCallback(() => armMobileSessionRebalance(hostDeviceId, sessionId, true), [hostDeviceId, sessionId]);
  const undo = useCallback(() => armMobileSessionRebalance(hostDeviceId, sessionId, false), [hostDeviceId, sessionId]);
  const dismiss = useCallback(
    () => dismissMobileSessionRebalance(invoke, hostDeviceId, sessionId),
    [invoke, hostDeviceId, sessionId],
  );
  return { hint, arm, undo, dismiss };
}

/** 取走问好的提议：一次提议只用于一条消息，过期的不用。 */
function takePrefetched(hostDeviceId: string, sessionId: string): PrefetchedEntry | null {
  const key = cacheKey(hostDeviceId, sessionId);
  const entry = prefetched.get(key);
  if (!entry) return null;
  bumpGeneration(key);
  setEntry(key, null);
  return isFresh(entry) ? entry : null;
}

/**
 * 发送前调用：auto 类提议，或用户点过「切换」的 ask 类提议，就把换号记到任务所在电脑(它在这条消息发出前换过去，
 * 调用方要等它返回再发)；没点切换、没有提议时立即返回，不等网络，这条消息照常用当前账号发。不拦发送。
 */
export async function offerMobileSessionRebalance(input: {
  invoke: Invoke;
  hostDeviceId: string;
  sessionId: string;
  clientId: string;
}): Promise<void> {
  const { invoke, hostDeviceId, sessionId } = input;
  const entry = takePrefetched(hostDeviceId, sessionId);
  const suggestion = entry?.suggestion;
  if (!suggestion || (suggestion.kind === 'ask' && !entry.armed)) return;
  try {
    await invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{
      action: 'rebalance-decision',
      sessionId,
      clientId: input.clientId,
      memberKey: suggestion.memberKey,
      remember: false,
    }]);
  } catch {
    // 没记上就是这条照常发到原来的账号。
  }
}

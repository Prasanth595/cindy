/**
 * 任务进行中换号(provider-groups.md §6.2)：任务空闲时看任务所在电脑是否提议为了均匀用完各账号的配额换一台。
 * 2026-10-22 用户裁决：不再弹窗，改成输入框上方的一行提示——不操作就继续用当前账号；点「切换」后下一条消息换过去；
 * 点 × 这一轮不再提醒(由任务所在电脑记住)。组设置里打开「自动换号」的不显示提示、直接换，消息里的分隔条写明原因。
 *
 * 换号的判断和记录都在任务所在电脑：本机任务问本机，被控电脑上的任务经设备互联问那台。为了不让每次发送都多等一次往返，
 * 提议在任务空闲时预先问好(上一轮结束、打开任务时，空闲期间每 5 分钟再问)，发送时只用问好的结果；没问到、问不到、
 * 旧版本不认识这个请求都按不提议处理。无论换不换，这条消息都照常发出。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { formatQuotaResetCountdown } from '@/components/status/usageCardModel';

import {
  parseProviderGroupRebalanceSuggestion,
  type ProviderGroupCommand,
  type ProviderGroupRebalanceSuggestion,
} from '../../../shared/providerGroup';

/** 预先问一次的上限：问不到就当没有提议，不留着挂起的请求。 */
export const SESSION_REBALANCE_QUERY_TIMEOUT_MS = 5_000;
/** 问到的提议多久内可用：与组所在电脑判断配额用的快照有效期一致。 */
export const SESSION_REBALANCE_CACHE_MS = 10 * 60_000;
/** 任务空闲、开着时多久重新问一次。 */
export const SESSION_REBALANCE_REFRESH_MS = 5 * 60_000;
const MAX_PREFETCHED = 200;

type Suggestion = NonNullable<ProviderGroupRebalanceSuggestion>;

/** 输入框上方的提示：`armed` = 用户点了「切换」，下一条消息换过去。 */
export interface SessionRebalanceHintState {
  suggestion: Suggestion;
  armed: boolean;
}

type RebalanceRequest = Extract<
  ProviderGroupCommand,
  { action: 'rebalance-suggestion' | 'rebalance-decision' | 'rebalance-decline' }
>;

interface Entry {
  at: number;
  suggestion: ProviderGroupRebalanceSuggestion;
  armed: boolean;
  /** 给 React 的稳定快照：只在提议或点选变化时换新对象。 */
  hint: SessionRebalanceHintState | null;
}

const prefetched = new Map<string, Entry>();
const inFlight = new Set<string>();
/** 关掉提示或发出消息时加一：在那之前发出、之后才回来的预先问不再写回(不让关掉的提示又冒出来)。 */
const generations = new Map<string, number>();
/** 关掉提示后本机也先不再显示到这个时刻：任务所在电脑是旧版本、记不住关掉时，提示不会过 5 分钟又出现。 */
const localSnooze = new Map<string, number>();
/** 本机暂不显示最多多久(周配额窗口)；读不到重置时间时先停 10 分钟，之后交给任务所在电脑的记录。 */
const LOCAL_SNOOZE_MAX_MS = 7 * 24 * 60 * 60_000;
const LOCAL_SNOOZE_FALLBACK_MS = SESSION_REBALANCE_CACHE_MS;
const listeners = new Set<() => void>();

function cacheKey(sessionId: string, hostDeviceId: string | undefined): string {
  return `${hostDeviceId ?? ''}\u0000${sessionId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setEntry(key: string, suggestion: ProviderGroupRebalanceSuggestion, armed: boolean, at = Date.now()): void {
  prefetched.delete(key);
  prefetched.set(key, {
    at,
    suggestion,
    armed,
    hint: suggestion?.kind === 'ask' ? { suggestion, armed } : null,
  });
  if (prefetched.size > MAX_PREFETCHED) prefetched.delete(prefetched.keys().next().value!);
  emit();
}

function dropEntry(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  if (generations.size > MAX_PREFETCHED) generations.delete(generations.keys().next().value!);
  if (prefetched.delete(key)) emit();
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

async function command(hostDeviceId: string | undefined, request: RebalanceRequest): Promise<unknown> {
  if (hostDeviceId) {
    const deviceLink = window.electronAPI?.deviceLink;
    if (typeof deviceLink?.invoke !== 'function') return null;
    return deviceLink.invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request]);
  }
  const api = window.electronAPI?.providerGroup;
  if (typeof api?.command !== 'function') return null;
  return api.command(request);
}

/** 任务空闲时预先问好提议。同一个任务同时只问一次。@param hostDeviceId 任务所在的被控电脑；本机任务不传。 */
export async function prefetchSessionRebalance(sessionId: string, hostDeviceId?: string): Promise<void> {
  const key = cacheKey(sessionId, hostDeviceId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const generation = generations.get(key);
  try {
    const raw = await withTimeout(command(hostDeviceId, { action: 'rebalance-suggestion', sessionId }), null);
    if (generations.get(key) !== generation) return;
    const parsed = parseProviderGroupRebalanceSuggestion(raw);
    const snoozedUntil = localSnooze.get(key);
    if (snoozedUntil !== undefined && snoozedUntil <= Date.now()) localSnooze.delete(key);
    const suggestion = parsed?.kind === 'ask' && (localSnooze.get(key) ?? 0) > Date.now() ? null : parsed;
    const previous = prefetched.get(key);
    // 还是同一台：用户点过的「切换」保留，提示不闪。
    const armed = !!previous?.armed && !!suggestion && previous.suggestion?.memberKey === suggestion.memberKey;
    setEntry(key, suggestion, armed);
  } finally {
    inFlight.delete(key);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 开着的任务空闲时预先问好提议(变空闲、打开任务时问一次，之后每 5 分钟再问)，返回输入框上方要显示的提示；
 * 没有提议、组里设了自动换号、正在回复时为 null。
 */
export function useSessionRebalanceHint(
  sessionId: string | undefined,
  hostDeviceId: string | undefined,
  idle: boolean,
): SessionRebalanceHintState | null {
  useEffect(() => {
    if (!sessionId || !idle) return;
    void prefetchSessionRebalance(sessionId, hostDeviceId);
    const timer = setInterval(() => void prefetchSessionRebalance(sessionId, hostDeviceId), SESSION_REBALANCE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [sessionId, hostDeviceId, idle]);
  const getSnapshot = useCallback(
    () => (sessionId ? prefetched.get(cacheKey(sessionId, hostDeviceId))?.hint ?? null : null),
    [sessionId, hostDeviceId],
  );
  const hint = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return idle ? hint : null;
}

/** 点「切换」/「撤销」：只改本机这条提示，真正的确认在发送时随消息一起交给任务所在电脑。 */
export function armSessionRebalance(sessionId: string, hostDeviceId: string | undefined, armed: boolean): void {
  const key = cacheKey(sessionId, hostDeviceId);
  const entry = prefetched.get(key);
  if (!entry?.suggestion || entry.armed === armed) return;
  setEntry(key, entry.suggestion, armed, entry.at);
}

/** 点 ×：提示立刻收起，任务所在电脑记下这一轮不再提议。旧版本不认识这个请求时只收起这一次。 */
export async function dismissSessionRebalance(sessionId: string, hostDeviceId: string | undefined): Promise<void> {
  const key = cacheKey(sessionId, hostDeviceId);
  const resetAtMs = prefetched.get(key)?.suggestion?.quota.resetAtMs ?? null;
  const now = Date.now();
  localSnooze.delete(key);
  localSnooze.set(key, resetAtMs !== null && resetAtMs > now
    ? Math.min(resetAtMs, now + LOCAL_SNOOZE_MAX_MS)
    : now + LOCAL_SNOOZE_FALLBACK_MS);
  if (localSnooze.size > MAX_PREFETCHED) localSnooze.delete(localSnooze.keys().next().value!);
  dropEntry(key);
  try {
    await command(hostDeviceId, { action: 'rebalance-decline', sessionId });
  } catch {
    // 下次空闲问到时照常再提醒。
  }
}

async function recordDecision(
  sessionId: string,
  memberKey: string,
  hostDeviceId: string | undefined,
  clientId: string,
): Promise<boolean> {
  try {
    const raw = await command(hostDeviceId, { action: 'rebalance-decision', sessionId, memberKey, remember: false, clientId });
    return !!raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** 提示里那台的配额：还剩多少、多久重置。 */
export function describeSessionRebalanceQuota(suggestion: Suggestion, t: TFunction, nowMs = Date.now()): string {
  const left = Math.max(0, Math.round(100 - suggestion.quota.usedPercent));
  const reset = suggestion.quota.resetAtMs === null
    ? null
    : formatQuotaResetCountdown(suggestion.quota.resetAtMs / 1000, nowMs, t);
  return reset
    ? t('providerGroup.rebalance.quotaReset', { left, reset })
    : t('providerGroup.rebalance.quota', { left });
}

/**
 * 发送前取走问好的提议；返回的闭包在消息创建后绑定 clientId 记录确认。用户点过「切换」或组里设了自动换号才换，
 * 否则这条照常发到当前账号。不等网络、不弹窗，一次提议只用于一条消息，过期的不用。
 */
export function takeSessionRebalance(
  sessionId: string,
  hostDeviceId?: string,
): ((clientId: string) => Promise<void>) | undefined {
  const key = cacheKey(sessionId, hostDeviceId);
  const entry = prefetched.get(key);
  dropEntry(key);
  if (!entry?.suggestion || Date.now() - entry.at > SESSION_REBALANCE_CACHE_MS) return;
  if (entry.suggestion.kind !== 'auto' && !entry.armed) return;
  const { memberKey } = entry.suggestion;
  return async (clientId) => { await recordDecision(sessionId, memberKey, hostDeviceId, clientId); };
}

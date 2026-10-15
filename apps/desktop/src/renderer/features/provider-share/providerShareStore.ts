/**
 * 供应商分享在 Renderer 里的两份共享状态(模块级单例，app 生命周期常驻，与
 * useDeviceLinkDeviceList 同一做法)：
 *
 *  - 已收到的分享(受邀者)：首个订阅者触发一次 `received`，之后靠 RECEIVED_CHANGED 推送。
 *    分享的状态、在线或所在电脑变化时刷新对应 `share:<id>` 的模型目录缓存，消失的分享作废缓存。
 *  - 待审批申请(分享者)：由全局审批宿主播种(`owned` 一次)、REQUESTED 推送追加、审批后移除；
 *    管理页每次读取 `owned` 也会发布到这里。设置页入口的提示点读这份。
 *
 * 注意：`owned` 会让 main 进入快速拉取(每 5 秒)，所以这里**不**在每次 OWNED_CHANGED 都重读，
 * 只在还有待审批申请时重读(那时 main 本来就在快速拉取)，以便撤回、过期的申请及时消失。
 */
import { useSyncExternalStore } from 'react';

import type { ProviderShareReceived } from '@cindy/device-link';

import { getCachedDeviceProviders } from '@/hooks/useDeviceProviders';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { createLogger } from '@/lib/logger';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getProviderShareFavoriteRegions, reconcileProviderShareFavorites } from '@/state/providerShareFavorites';

import type {
  ProviderShareOwnerState,
  ProviderShareRequestedEvent,
} from '../../../shared/providerShare';
import {
  diffReceivedShares,
  pendingRequestsFromOwned,
  providerShareAgentDeviceId,
  type ProviderSharePendingRequest,
} from './providerShareFormat';

const log = createLogger('providerShareStore');

type ProviderShareApi = Window['electronAPI']['providerShare'];

function providerShareApi(): ProviderShareApi | null {
  return (window as Partial<Window>).electronAPI?.providerShare ?? null;
}

// ─── 已收到的分享 ────────────────────────────────────────────────

export interface ReceivedSnapshot {
  received: readonly ProviderShareReceived[];
  /** 已拿到过一次权威列表(命令返回或推送)。 */
  loaded: boolean;
}

let receivedSnapshot: ReceivedSnapshot = { received: [], loaded: false };
let receivedStarted = false;
/** 推送序号：首次 `received` 命令晚于推送返回时，不得用旧列表覆盖。 */
let receivedPushSeq = 0;
const receivedSubscribers = new Set<() => void>();

function invalidateShareCatalogs(
  previous: readonly ProviderShareReceived[],
  next: readonly ProviderShareReceived[],
): void {
  // 设备互联断开 / 换账号时 main 先推一份空列表：那是「暂时读不到」，不作废已取到的目录，
  // 否则重连后列表原样回来(前后无差异)也不会再触发重取。
  if (next.length === 0) return;
  const { changed, removed } = diffReceivedShares(previous, next);
  for (const shareId of changed) {
    void refreshRemoteCatalogSnapshot(providerShareAgentDeviceId(shareId)).catch(() => undefined);
  }
  for (const shareId of removed) {
    const deviceId = providerShareAgentDeviceId(shareId);
    // 没取过目录就没有要作废的缓存；取过的重取一次，让模型列表拿到「已不可用」。
    if (getCachedDeviceProviders(deviceId)) {
      void refreshRemoteCatalogSnapshot(deviceId).catch(() => undefined);
    }
  }
}

function setReceived(next: readonly ProviderShareReceived[]): void {
  const previous = receivedSnapshot.received;
  receivedSnapshot = { received: next, loaded: true };
  invalidateShareCatalogs(previous, next);
  for (const listener of receivedSubscribers) listener();
}

type ShareRegion = ProviderShareReceived['owner']['region'];

let membershipRequest = 0;
let membershipRetryTimer: ReturnType<typeof setTimeout> | null = null;
let membershipFailures = 0;
/** 远程任务所在电脑的收藏不在本机存储里，它们的区域同样是查询线索；按账号隔离，换账号即作废。 */
let favoriteRegionHints: { dataOwnerId: string | null; regions: ReadonlySet<ShareRegion> } = {
  dataOwnerId: null, regions: new Set(),
};

function hintedFavoriteRegions(dataOwnerId: string | null): readonly ShareRegion[] {
  return favoriteRegionHints.dataOwnerId === dataOwnerId ? [...favoriteRegionHints.regions] : [];
}

function refreshFavoriteMembership(api: ProviderShareApi): void {
  if (membershipRetryTimer) clearTimeout(membershipRetryTimer);
  membershipRetryTimer = null;
  const request = ++membershipRequest;
  const owner = getDataOwnerGeneration();
  const current = () => request === membershipRequest && isDataOwnerGenerationCurrent(owner);
  const retry = () => {
    if (!current()) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(membershipFailures++, 4));
    membershipRetryTimer = setTimeout(() => {
      membershipRetryTimer = null;
      if (current()) refreshFavoriteMembership(api);
    }, delay);
  };
  void (async () => {
    try {
      let local: ShareRegion[] = [];
      try { local = getProviderShareFavoriteRegions(owner.dataOwnerId); }
      catch { /* 清理器会报告存储错误并安排重试；读取恢复后再补齐区域线索。 */ }
      const regions = [...new Set([...local, ...hintedFavoriteRegions(owner.dataOwnerId)])];
      const snapshot = await api.command({
        action: 'received-snapshot',
        favoriteRecovery: { ownerStamp: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation }, regions },
      });
      if (!current()) return;
      const cleaned = reconcileProviderShareFavorites(snapshot);
      if (!cleaned || regions.some((region) => !snapshot.confirmedRegions.includes(region))) retry();
      else membershipFailures = 0;
    } catch { retry(); } // 读失败不是撤权，重取最新名单而不是重放旧删除。
  })();
}

/** 启动已收到分享的同步(幂等)。Preload 不可用(测试 / 旧窗口)时什么都不做。 */
export function ensureProviderShareReceivedStarted(): void {
  if (receivedStarted) return;
  const api = providerShareApi();
  if (!api) return;
  receivedStarted = true;
  api.onReceivedChanged((list) => {
    receivedPushSeq += 1;
    setReceived(Array.isArray(list) ? list : []);
    refreshFavoriteMembership(api);
  });
  const seqAtRequest = receivedPushSeq;
  void api
    .command({ action: 'received' })
    .then((list) => {
      if (receivedPushSeq !== seqAtRequest) return;
      setReceived(list);
      refreshFavoriteMembership(api);
    })
    .catch((error: unknown) => {
      log.debug('provider share received list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (receivedPushSeq === seqAtRequest) refreshFavoriteMembership(api);
    });
}

/** AuthContext 的同账号修复不会重挂宿主，generation 更新时仍须重新核对收藏。 */
export function refreshProviderShareFavoriteMembership(): void {
  if (!receivedStarted) {
    ensureProviderShareReceivedStarted();
    return;
  }
  const api = providerShareApi();
  if (api) refreshFavoriteMembership(api);
}

/**
 * 远程任务读写任务所在电脑的收藏：其中分享收藏的区域本机可能从没加载过，补进查询线索并重新
 * 核对一次名单，让对方区域的授权被恢复。区域已在线索里时什么都不做。
 */
export function requestProviderShareFavoriteRegions(regions: readonly ShareRegion[]): void {
  const { dataOwnerId } = getDataOwnerGeneration();
  const known = favoriteRegionHints.dataOwnerId === dataOwnerId ? favoriteRegionHints.regions : new Set<ShareRegion>();
  if (regions.every((region) => known.has(region))) return;
  favoriteRegionHints = { dataOwnerId, regions: new Set([...known, ...regions]) };
  refreshProviderShareFavoriteMembership();
}

/** 主动再取一次(退出分享后立即刷新列表；推送仍会随后到达)。 */
export function refreshProviderShareReceived(): void {
  const api = providerShareApi();
  if (!api) return;
  const seqAtRequest = receivedPushSeq;
  void api
    .command({ action: 'received' })
    .then((list) => {
      if (receivedPushSeq !== seqAtRequest) return;
      setReceived(list);
      refreshFavoriteMembership(api);
    })
    .catch(() => undefined);
}

function subscribeReceived(listener: () => void): () => void {
  ensureProviderShareReceivedStarted();
  receivedSubscribers.add(listener);
  return () => {
    receivedSubscribers.delete(listener);
  };
}

function getReceivedSnapshot(): ReceivedSnapshot {
  return receivedSnapshot;
}

export function useProviderShareReceived(): ReceivedSnapshot {
  return useSyncExternalStore(subscribeReceived, getReceivedSnapshot, getReceivedSnapshot);
}

// ─── 待审批申请(分享者) ────────────────────────────────────────

let pendingRequests: readonly ProviderSharePendingRequest[] = [];
const pendingSubscribers = new Set<() => void>();

function setPending(next: readonly ProviderSharePendingRequest[]): void {
  pendingRequests = next;
  for (const listener of pendingSubscribers) listener();
}

/** 一份 owned 快照是本机待审批申请的权威来源：整体替换。 */
export function publishProviderShareOwnerState(state: ProviderShareOwnerState): void {
  setPending(state.ready ? pendingRequestsFromOwned(state.shares) : []);
}

export function addProviderShareRequested(event: ProviderShareRequestedEvent): void {
  if (pendingRequests.some((item) => item.request.requestId === event.request.requestId)) return;
  setPending([...pendingRequests, { request: event.request, share: event.share }]);
}

export function removeProviderSharePendingRequest(requestId: string): void {
  if (!pendingRequests.some((item) => item.request.requestId === requestId)) return;
  setPending(pendingRequests.filter((item) => item.request.requestId !== requestId));
}

export function getProviderSharePendingRequests(): readonly ProviderSharePendingRequest[] {
  return pendingRequests;
}

function subscribePending(listener: () => void): () => void {
  pendingSubscribers.add(listener);
  return () => {
    pendingSubscribers.delete(listener);
  };
}

export function useProviderSharePendingRequests(): readonly ProviderSharePendingRequest[] {
  return useSyncExternalStore(subscribePending, getProviderSharePendingRequests, getProviderSharePendingRequests);
}

/** 读一次 owned 并发布(审批宿主播种 / 有待审批申请时随推送重读)。 */
export async function refreshProviderShareOwnerPending(): Promise<ProviderShareOwnerState | null> {
  const api = providerShareApi();
  if (!api) return null;
  try {
    const state = await api.command({ action: 'owned', range: 'month' });
    publishProviderShareOwnerState(state);
    return state;
  } catch (error) {
    log.debug('provider share owner state unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 仅测试用：重置模块状态。 */
export function resetProviderShareStoreForTests(): void {
  receivedSnapshot = { received: [], loaded: false };
  receivedStarted = false;
  receivedPushSeq = 0;
  membershipRequest += 1;
  if (membershipRetryTimer) clearTimeout(membershipRetryTimer);
  membershipRetryTimer = null;
  membershipFailures = 0;
  favoriteRegionHints = { dataOwnerId: null, regions: new Set() };
  receivedSubscribers.clear();
  pendingRequests = [];
  pendingSubscribers.clear();
}

/** 受邀者可见的组状态：白名单投影，不携带组员身份和用量，也不分配任务或改变冷却。 */
import type { ProviderShareGroupState, RemoteAgentCaps } from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupGuestSupport, ProviderGroupMember } from '../../shared/providerGroup.js';
import type { ProviderGroupOwnerScope } from './runtime.js';

export const SHARED_GROUP_STATUS_TIMEOUT_MS = 3_000;
export const SHARED_GROUP_STATUS_CAPS_CONCURRENCY = 4;
export const SHARED_GROUP_STATUS_CAPS_CACHE_MS = 15_000;

export interface SharedGroupStatusDeps {
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  readCaps(member: ProviderGroupMember): Promise<RemoteAgentCaps>;
  isIncapable(agentDeviceId: string): boolean;
  /**
   * 转分享(provider-sharing.md §4.3)：分享来的电脑的主人没同意过读状态的这个受邀者时，他看到的状态
   * (暂不可用，或那台需要更新才能同意)；同意过或不是分享来的电脑返回 null。
   */
  reshareState?(member: ProviderGroupMember): ProviderShareGroupState | null;
}

async function readWithin<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SHARED_GROUP_STATUS_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sharedSupportReaders = new WeakMap<ProviderGroupOwnerScope['router'], ReturnType<typeof createGuestSupportReader>>();

/** 按电脑合并有界能力探测，保留物理在途槽与短缓存；沿用真正接收分享任务时的能力条件。 */
export function createGuestSupportReader(readCaps: SharedGroupStatusDeps['readCaps']) {
  const caps = new Map<string, { promise: Promise<RemoteAgentCaps | null>; expiresAt: number }>();
  const queued = new Set<() => void>();
  let active = 0;
  function drain() {
    for (const start of queued) {
      if (active >= SHARED_GROUP_STATUS_CAPS_CONCURRENCY) break;
      start();
    }
  }
  return async (member: ProviderGroupMember): Promise<ProviderGroupGuestSupport> => {
    if (!member.agentDeviceId) return 'supported';
    const now = Date.now();
    for (const [agentDeviceId, entry] of caps) {
      if (entry.expiresAt <= now) caps.delete(agentDeviceId);
    }
    let pending = caps.get(member.agentDeviceId);
    if (!pending) {
      const agentDeviceId = member.agentDeviceId;
      const promise = new Promise<RemoteAgentCaps | null>((resolve) => {
        const cancel = () => {
          queued.delete(start);
          clearTimeout(timer);
          caps.delete(agentDeviceId);
          resolve(null);
        };
        const start = () => {
          if (Date.now() >= now + SHARED_GROUP_STATUS_TIMEOUT_MS) {
            cancel();
            return;
          }
          queued.delete(start);
          clearTimeout(timer);
          active += 1;
          void Promise.resolve().then(() => readCaps(member)).catch(() => null).then(resolve).finally(() => {
            active -= 1;
            drain();
          });
        };
        const timer = setTimeout(cancel, SHARED_GROUP_STATUS_TIMEOUT_MS);
        queued.add(start);
        drain();
      });
      const entry = { promise, expiresAt: Infinity };
      void promise.then(() => { entry.expiresAt = Date.now() + SHARED_GROUP_STATUS_CAPS_CACHE_MS; });
      pending = entry;
      caps.set(member.agentDeviceId, pending);
    }
    const promise = pending.promise;
    const capability = await readWithin(() => promise);
    if (!capability) return 'unknown';
    return capability.virtualWorkspace === true
      && (member.kind === 'device'
        ? capability.guestRelay === true
        : member.kind !== 'share' || capability.reshareConsent === true)
      ? 'supported' : 'needs-update';
  };
}

export async function readSharedGroupStatus(deps: SharedGroupStatusDeps, providerId: string): Promise<ProviderShareGroupState[] | null> {
  const scope = deps.scope();
  const config = deps.readGroup(providerId);
  if (!config) return null;
  const view = await readWithin(() => scope.router.view(providerId));
  if (!scope.isCurrent()) return null;
  const readSupport = sharedSupportReaders.get(scope.router) ?? createGuestSupportReader(async (member) => {
    if (!scope.isCurrent()) throw new Error('The account changed');
    return deps.readCaps(member);
  });
  sharedSupportReaders.set(scope.router, readSupport);
  const states = await Promise.all(config.members.map(async (member): Promise<ProviderShareGroupState> => {
    if (member.paused) return 'paused';
    const status = view?.members.find((item) => item.key === member.key);
    if (!status) return 'unknown';
    if (status.state !== 'available' && status.state !== 'full') return status.state;
    // 与实际分配一致：主人没同意过这个人的分享来的电脑不会分给他。
    const reshare = deps.reshareState?.(member) ?? null;
    if (reshare) return reshare;
    if (member.agentDeviceId) {
      // 与实际接任务的条件一致；旧版同账号组员可能主人能用，受邀者却不能用。
      if (member.kind === 'device' && deps.isIncapable(member.agentDeviceId)) return 'needs-update';
      const support = await readSupport(member);
      if (support !== 'supported') return support;
    }
    // 满载仍能接任务；只报粗略忙闲，绝不返回任务数和上限。
    return status.running > 0 || status.state === 'full' ? 'busy' : 'available';
  }));
  // 读取期间换账号或编辑组时丢弃快照，避免将旧组状态贴到新组序号上。
  const latest = deps.readGroup(providerId);
  return scope.isCurrent() && JSON.stringify(latest) === JSON.stringify(config) ? states : null;
}

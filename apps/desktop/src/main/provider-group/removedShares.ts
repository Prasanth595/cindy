/**
 * 原分享被删除或已退出(docs/product-rules/provider-groups.md §3、provider-sharing.md §4.3)：这个账号收到的分享里
 * 已经没有它了，组里指向它的电脑移出组，本机自己与本机分享的人都不再用到它。
 * 只在已收到的分享名单完整可信时判断(说不准时什么都不做)；分享只是暂停时仍在名单里，不动。
 */
import type { ProviderGroupConfig } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId, PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../shared/providerShare.js';

export interface PruneRemovedShareMembersDeps {
  /** 完整可信的已收到分享名单(分享 id)；说不准时为 null。 */
  confirmedShareIds(): ReadonlySet<string> | null;
  listGroups(): Record<string, ProviderGroupConfig>;
  writeGroup(providerId: string, config: unknown): Promise<unknown>;
  /** 解除指向已不在组里的电脑的任务绑定；keep 为 null = 整个组已删除。 */
  pruneBindings(providerId: string, keep: ReadonlySet<string> | null): Promise<void>;
  /** 当前账号：读名单与写入之间换了账号时停下。 */
  ownerKey(): string;
  changed(providerId: string): void;
}

function goneMembers(config: ProviderGroupConfig, received: ReadonlySet<string>) {
  return config.members.filter((member) =>
    member.kind === 'share'
    && member.agentDeviceId !== null
    && isProviderShareAgentDeviceId(member.agentDeviceId)
    && !received.has(member.agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length)));
}

/** 移出指向已不在的分享的组内电脑并解除对应的任务绑定，返回移出的组内电脑的键。 */
export async function pruneRemovedShareMembers(deps: PruneRemovedShareMembersDeps): Promise<string[]> {
  const owner = deps.ownerKey();
  const received = deps.confirmedShareIds();
  if (!received) return [];
  const removed: string[] = [];
  for (const providerId of Object.keys(deps.listGroups())) {
    if (deps.ownerKey() !== owner) break;
    // 每个组写之前现读一次：前一个组的写入期间设置页可能改过这个组。
    const config = deps.listGroups()[providerId];
    if (!config) continue;
    const gone = goneMembers(config, received);
    if (gone.length === 0) continue;
    const keep = config.members.filter((member) => !gone.includes(member));
    await deps.writeGroup(providerId, keep.length > 0 ? { ...config, members: keep } : null);
    if (deps.ownerKey() !== owner) break;
    await deps.pruneBindings(providerId, keep.length > 0 ? new Set(keep.map((member) => member.key)) : null);
    if (deps.ownerKey() !== owner) break;
    removed.push(...gone.map((member) => member.key));
    deps.changed(providerId);
  }
  return removed;
}

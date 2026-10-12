/**
 * 「用量」块的纯函数(供应商组 §7)：把同一个人的几份用量合成一份，再按组内电脑分开。
 * 不读 window、不碰 i18n，便于单测。
 */
import type { ProviderShareModelUsageView, ProviderShareMoney } from '../../../shared/providerShare';

function addMoney(a: ProviderShareMoney | null, b: ProviderShareMoney | null): ProviderShareMoney | null | 'mixed' {
  if (!a) return b;
  if (!b) return a;
  if (a.currency !== b.currency) return 'mixed';
  return { amount: a.amount + b.amount, currency: a.currency };
}

/**
 * 合并几份按模型的用量：同一 Agent、供应商、模型、组内电脑的行相加。
 * `ignoreMember` 时不分组内电脑(没有组的供应商按模型列)。金额币种不一致的那一行不给金额，不伪造合计。
 */
export function mergeModelUsage(
  lists: ReadonlyArray<readonly ProviderShareModelUsageView[]>,
  options: { ignoreMember?: boolean } = {},
): ProviderShareModelUsageView[] {
  const merged = new Map<string, ProviderShareModelUsageView & { mixed?: boolean }>();
  for (const list of lists) {
    for (const row of list) {
      const memberKey = options.ignoreMember ? null : row.memberKey;
      const key = JSON.stringify([row.kind, row.providerId, row.model, memberKey]);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...row, memberKey, amount: row.amount ? { ...row.amount } : null });
        continue;
      }
      existing.turns += row.turns;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheCreateTokens += row.cacheCreateTokens;
      if (existing.mixed) continue;
      const amount = addMoney(existing.amount, row.amount);
      if (amount === 'mixed') {
        existing.mixed = true;
        existing.amount = null;
      } else {
        existing.amount = amount;
      }
    }
  }
  return [...merged.values()]
    .map(({ mixed: _mixed, ...row }) => row)
    .sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}

export interface MemberUsageGroup {
  /** 组内电脑的稳定键；null = 更早的、没有区分电脑的用量。 */
  memberKey: string | null;
  /** 现在还在组里。 */
  inGroup: boolean;
  models: ProviderShareModelUsageView[];
}

/**
 * 按组内电脑分开：组里每台都列出(这段时间没用过的也列，好看出全组的分布)，按组里的顺序；
 * 之后是已经移出组、但这段时间用过的电脑；最后是没有区分电脑的更早记录。
 */
export function groupUsageByMember(
  models: readonly ProviderShareModelUsageView[],
  memberKeys: readonly string[],
): MemberUsageGroup[] {
  const byKey = new Map<string | null, ProviderShareModelUsageView[]>();
  for (const row of models) {
    const list = byKey.get(row.memberKey);
    if (list) list.push(row);
    else byKey.set(row.memberKey, [row]);
  }
  const groups: MemberUsageGroup[] = memberKeys.map((memberKey) => ({
    memberKey,
    inGroup: true,
    models: byKey.get(memberKey) ?? [],
  }));
  const known = new Set(memberKeys);
  for (const [memberKey, list] of byKey) {
    if (memberKey === null || known.has(memberKey)) continue;
    groups.push({ memberKey, inGroup: false, models: list });
  }
  const unattributed = byKey.get(null);
  if (unattributed?.length) groups.push({ memberKey: null, inGroup: false, models: unattributed });
  return groups;
}

/** 组内电脑的稳定键里那台电脑的设备 id(`device:<deviceId>:<providerId>`)；不是同账号电脑时为 null。 */
export function deviceIdOfMemberKey(memberKey: string): string | null {
  if (!memberKey.startsWith('device:')) return null;
  const rest = memberKey.slice('device:'.length);
  const end = rest.indexOf(':');
  return end > 0 ? rest.slice(0, end) : null;
}

/** 分享来的电脑的稳定键里的任务位置(`share:<shareId>:<providerId>` → `share:<shareId>`)。 */
export function shareAgentDeviceIdOfMemberKey(memberKey: string): string | null {
  if (!memberKey.startsWith('share:')) return null;
  const rest = memberKey.slice('share:'.length);
  const end = rest.indexOf(':');
  return end > 0 ? `share:${rest.slice(0, end)}` : null;
}

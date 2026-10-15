/**
 * 「远程与分享」页的「用量」块(供应商组 §7、§10)：按人列出这个供应商的用量——你自己(当前登录的账号，
 * 本机与你其他电脑的合计)、分享的人(按人分开)，共用一个时间段切换。收起时是这个人的总量；展开后按电脑分开
 * (每台下面列模型)。没有组的供应商当成只有本机一台的组，与建了组的走同一套显示(2026-10-12 用户要求)：
 * 账本里不经组、就在本机运行的用量本来就记在本机(`local`)上。
 *
 * 自己的用量来自这台电脑的账本(main 的 own-usage，含你其他电脑经组在别的组内电脑上运行、报告过来的部分)，
 * 分享的人来自分享服务的成员用量。
 */
import { ChevronRight, History, Monitor } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { formatModelShort } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';

import { PROVIDER_GROUP_LOCAL_MEMBER_KEY } from '../../../shared/providerGroup';
import type {
  ProviderOwnUsageView,
  ProviderShareMemberView,
  ProviderShareModelUsageView,
  ProviderShareUsageRange,
} from '../../../shared/providerShare';
import { formatShareMoney, formatShareTokens, summarizeShareUsage } from './providerShareFormat';
import { providerShareComputerName, useProviderShareOwnerNameOf } from './providerShareNames';
import {
  deviceIdOfMemberKey,
  groupUsageByMember,
  mergeModelUsage,
  shareAgentDeviceIdOfMemberKey,
  type MemberUsageGroup,
} from './providerUsageBreakdown';
import { ShareAvatar } from './ShareAvatar';
import type { ShareTimeFormat } from './useShareTimeFormat';

const RANGES: readonly ProviderShareUsageRange[] = ['7d', 'month', 'all'];

interface UsageParty {
  key: string;
  name: string;
  /** 名字旁的说明：你 / 分享的人。 */
  tag: string | null;
  /** 人用头像；经另一台电脑转来的(看不到具体的人)用设备图标。 */
  person?: { displayName: string; avatarUrl?: string | null };
  lastUsedAt: number | null;
  models: ProviderShareModelUsageView[];
}

interface MemberLabel {
  name: string;
  source: string | null;
}

export function ProviderUsageSection({
  providerId,
  providerName,
  own,
  ownFailed,
  members,
  membersLoading,
  selfDeviceName,
  range,
  onRangeChange,
  time,
}: {
  providerId: string;
  providerName: string;
  /** null = 还没读到。 */
  own: ProviderOwnUsageView | null;
  ownFailed: boolean;
  members: readonly ProviderShareMemberView[];
  /** 分享服务的成员还没读到。 */
  membersLoading: boolean;
  selfDeviceName: string | null;
  range: ProviderShareUsageRange;
  onRangeChange: (range: ProviderShareUsageRange) => void;
  time: ShareTimeFormat;
}) {
  const { t } = useTranslation();
  const user = useOptionalAuthUser();
  const devices = useDeviceLinkDeviceList();
  const ownerNameOf = useProviderShareOwnerNameOf();
  const group = useLocalProviderGroups()[providerId] ?? null;
  const memberKeys = useMemo(
    () => group?.members.map((member) => member.key) ?? [PROVIDER_GROUP_LOCAL_MEMBER_KEY],
    [group],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const parties = useMemo<UsageParty[]>(() => {
    const rows: UsageParty[] = [];
    // 你自己一行总在，没用过也写出来：本机与你其他电脑的合计，和分享的人同样按人显示。
    if (own || ownFailed) {
      const selfName = user?.name?.trim() || t('settings.userProfile.local.name');
      const parts = [own?.local, ...(own?.devices ?? [])].filter(
        (part): part is NonNullable<typeof part> => part != null,
      );
      const lastUsedAt = parts.reduce<number | null>((latest, part) => Math.max(latest ?? 0, part.lastUsedAt), null);
      rows.push({
        key: 'self',
        name: selfName,
        tag: t('providerGroup.usage.selfTag'),
        person: { displayName: selfName, avatarUrl: user?.avatar ?? null },
        lastUsedAt,
        models: mergeModelUsage(parts.map((part) => part.models)),
      });
    }
    for (const member of members) {
      rows.push({
        key: `member:${member.memberId}`,
        name: member.displayName,
        tag: t('providerGroup.usage.shareSource'),
        person: { displayName: member.displayName, avatarUrl: member.avatarUrl },
        lastUsedAt: member.lastUsedAt,
        models: member.models,
      });
    }
    // 同账号的组所在电脑替它的受邀者转来的：这台电脑看不到具体的人，按那台电脑一行。
    for (const relay of own?.relays ?? []) {
      if (!relay.deviceId) continue;
      const device =
        devices?.find((item) => item.deviceId === relay.deviceId)?.name ||
        relay.deviceName ||
        t('providerGroup.usage.unknownDevice');
      rows.push({
        key: `relay:${relay.deviceId}`,
        name: t('providerGroup.usage.relayName', { device }),
        tag: t('providerGroup.usage.shareSource'),
        lastUsedAt: relay.lastUsedAt,
        models: relay.models,
      });
    }
    return rows;
  }, [devices, members, own, ownFailed, t, user?.avatar, user?.name]);

  const memberLabel = useCallback(
    (memberKey: string | null, inGroup: boolean): MemberLabel => {
      if (memberKey === null) return { name: t('providerGroup.usage.unattributed'), source: t('providerGroup.usage.unattributedSource') };
      const removed = inGroup ? null : t('providerGroup.usage.removedMember');
      if (memberKey === PROVIDER_GROUP_LOCAL_MEMBER_KEY) {
        return { name: t('providerGroup.member.local'), source: removed ?? selfDeviceName };
      }
      const member = group?.members.find((item) => item.key === memberKey);
      const deviceId = member?.kind === 'device' ? member.agentDeviceId : deviceIdOfMemberKey(memberKey);
      if (deviceId) {
        return {
          name: devices?.find((device) => device.deviceId === deviceId)?.name || member?.label || t('providerGroup.usage.unknownDevice'),
          source: removed ?? t('providerGroup.member.sourceDevice'),
        };
      }
      // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
      const shareDevice = member?.kind === 'share' ? member.agentDeviceId : shareAgentDeviceIdOfMemberKey(memberKey);
      const owner = shareDevice ? ownerNameOf(shareDevice) : null;
      return {
        name: shareDevice ? providerShareComputerName(t, owner) : t('providerGroup.usage.unknownDevice'),
        source: removed ?? (owner ? t('providerGroup.member.sourceShare', { name: owner }) : null),
      };
    },
    [devices, group, ownerNameOf, selfDeviceName, t],
  );

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 和设置 → 用量历史的摘要卡保持同一阅读顺序：先看总量，再看分布。
  // 这里只汇总已经读到的使用方；读失败的自己的账本不会被当成 0。
  const summary = useMemo(() => {
    const totals = summarizeShareUsage(parties.flatMap((party) => party.models));
    const usedParties = parties.filter((party) => {
      const partyTotals = summarizeShareUsage(party.models);
      return partyTotals.tokens > 0 || party.models.some((model) => model.turns > 0);
    }).length;
    const models = new Set(
      parties
        .flatMap((party) => party.models)
        .filter((model) => model.turns > 0 || model.inputTokens > 0 || model.outputTokens > 0)
        .map((model) => `${model.kind}:${model.providerId ?? ''}:${model.model}`),
    );
    return { ...totals, usedParties, modelCount: models.size };
  }, [parties]);

  return (
    <section className="mt-8 shrink-0" aria-labelledby="provider-usage-title">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h3 id="provider-usage-title" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('providerGroup.usage.title')}
          </h3>
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t(group ? 'providerGroup.usage.descriptionGroup' : 'providerGroup.usage.description', { provider: providerName })}
          </p>
        </div>
        <SegmentedControl
          value={range}
          onValueChange={onRangeChange}
          aria-label={t('providerShare.manage.members.rangeAria')}
          options={RANGES.map((value) => ({ value, label: t(`providerShare.manage.members.range.${value}`) }))}
        />
      </div>
      {parties.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="provider-usage-summary">
          <UsageSummaryCell
            value={summary.tokens > 0 ? formatShareTokens(summary.tokens) : '—'}
            label={t('providerGroup.usage.summary.total')}
          />
          <UsageSummaryCell
            value={summary.amount ? formatShareMoney(summary.amount) : '—'}
            label={t('providerGroup.usage.summary.amount')}
          />
          <UsageSummaryCell
            value={summary.usedParties > 0 ? String(summary.usedParties) : '—'}
            label={t('providerGroup.usage.summary.people')}
          />
          <UsageSummaryCell
            value={summary.modelCount > 0 ? String(summary.modelCount) : '—'}
            label={t('providerGroup.usage.summary.models')}
          />
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        {parties.length === 0 ? (
          <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
            {membersLoading || !own ? t('providerShare.manage.loading') : '—'}
          </p>
        ) : (
          parties.map((party, index) => (
            <UsagePartyRow
              key={party.key}
              party={party}
              first={index === 0}
              open={expanded.has(party.key)}
              unavailable={party.key === 'self' && ownFailed && !own}
              totalTokens={summary.tokens}
              memberKeys={memberKeys}
              showComputerCount={Boolean(group)}
              memberLabel={memberLabel}
              time={time}
              onToggle={() => toggle(party.key)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function UsageSummaryCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
      <span className="break-words text-16 font-medium leading-[1.4] tabular-nums text-[var(--text-primary)]">{value}</span>
      <span className="mt-auto break-words text-12 leading-[1.5] text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

function UsagePartyRow({
  party,
  first,
  open,
  unavailable,
  totalTokens,
  memberKeys,
  showComputerCount,
  memberLabel,
  time,
  onToggle,
}: {
  party: UsageParty;
  first: boolean;
  open: boolean;
  /** 自己的账本没读出来：不写 0，免得被当成没用过。 */
  unavailable: boolean;
  /** 所选时间段所有已读使用方的 token 总量，用来画轻量占比条。 */
  totalTokens: number;
  /** 组内电脑(按组里的顺序)；没有组时只有本机。 */
  memberKeys: readonly string[];
  /** 收起时写「用了几台电脑」：没有组时只有本机一台，这句没有信息量。 */
  showComputerCount: boolean;
  memberLabel: (memberKey: string | null, inGroup: boolean) => MemberLabel;
  time: ShareTimeFormat;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const totals = summarizeShareUsage(party.models);
  const share = totals.tokens > 0 && totalTokens > 0 ? Math.max(3, Math.round((totals.tokens / totalTokens) * 100)) : 0;
  const breakdown = useMemo(() => groupUsageByMember(party.models, memberKeys), [memberKeys, party.models]);
  const usedOn = showComputerCount
    ? breakdown.filter((item) => item.memberKey !== null && summarizeShareUsage(item.models).tokens > 0).length
    : 0;
  const breakdownId = `provider-usage-${party.key}`;
  const toggleLabel = t(open ? 'providerGroup.usage.collapseAria' : 'providerGroup.usage.expandAria', { name: party.name });
  const lastUsed = unavailable
    ? t('providerShare.manage.loadFailed')
    : party.lastUsedAt
      ? t('providerShare.manage.members.lastUsed', { time: time.relative(party.lastUsedAt) })
      : t('providerShare.manage.members.neverUsed');
  return (
    <div
      data-testid="provider-usage-row"
      data-usage-party={party.key}
      className={cn(!first && 'border-t border-[var(--settings-theme-card-border)]')}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors motion-reduce:transition-none hover:bg-[var(--surface-hover)]">
        <Tip text={toggleLabel}>
          <button
            type="button"
            onClick={onToggle}
            disabled={unavailable}
            aria-expanded={open}
            aria-controls={breakdownId}
            aria-label={toggleLabel}
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
          >
            <ChevronRight
              size={14}
              aria-hidden
              className={cn('transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
            />
          </button>
        </Tip>
        {party.person ? (
          <ShareAvatar displayName={party.person.displayName} avatarUrl={party.person.avatarUrl} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
          >
            <Monitor size={16} />
          </span>
        )}
        <div className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-2 text-13">
            <span className="font-medium text-[var(--text-primary)]">{party.name}</span>
            {party.tag && <span className="text-12 text-[var(--text-secondary)]">{party.tag}</span>}
          </div>
          <span className="text-12 text-[var(--text-secondary)]">
            {usedOn > 0 && !unavailable
              ? t('providerGroup.usage.lastUsedOn', { lastUsed, computers: t('providerGroup.usage.computerCount', { count: usedOn }) })
              : lastUsed}
          </span>
        </div>
        {!unavailable && (
          <div className="flex min-w-[108px] shrink-0 flex-col items-end text-12 text-[var(--text-secondary)]">
            <span className="text-13 font-medium text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
              {t('providerShare.manage.members.tokens', { tokens: formatShareTokens(totals.tokens) })}
            </span>
            {totals.amount && (
              <span className="[font-variant-numeric:tabular-nums]">
                {t('providerShare.manage.members.amount', { amount: formatShareMoney(totals.amount) })}
              </span>
            )}
            {share > 0 && (
              <span aria-hidden="true" className="mt-1.5 h-1 w-16 overflow-hidden rounded-full bg-[var(--surface-chip)]">
                <span
                  className="block h-full rounded-full bg-[var(--text-secondary)]"
                  style={{ width: `${share}%` }}
                />
              </span>
            )}
          </div>
        )}
      </div>
      {/* 明细表与头像左缘对齐：px-4 + 展开按钮(24 - 4) + gap-3 = 48px。 */}
      {open && !unavailable && (
        <div
          id={breakdownId}
          className="border-t border-[var(--border-default)] bg-[var(--surface)] px-3 py-3.5 sm:ml-12 sm:mr-3 sm:rounded-lg sm:border"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-12">
              <thead>
                <tr className="border-b border-[var(--border-default)] text-left text-[var(--text-secondary)]">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('providerGroup.usage.table.member')}</th>
                  <th scope="col" className="w-[72px] py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.turns')}</th>
                  <th scope="col" className="w-[88px] py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.input')}</th>
                  <th scope="col" className="w-[88px] py-1.5 pr-3 text-right font-medium">{t('providerShare.manage.members.table.output')}</th>
                  <th scope="col" className="w-[96px] py-1.5 text-right font-medium">{t('providerShare.manage.members.table.amount')}</th>
                </tr>
              </thead>
              {breakdown.map((item, index) => (
                <MemberUsageRows
                  key={item.memberKey ?? '\u0000unattributed'}
                  item={item}
                  first={index === 0}
                  label={memberLabel(item.memberKey, item.inGroup)}
                  partyTokens={totals.tokens}
                />
              ))}
            </table>
          </div>
          <p className="mt-2 text-12 text-[var(--text-tertiary)]">{t('providerShare.manage.members.estimateNote')}</p>
        </div>
      )}
    </div>
  );
}

/** 组内一台电脑：一行这台的合计(带占这个人总量的比例)，下面每个模型一行。这段时间没用过的整行变淡。 */
function MemberUsageRows({
  item,
  first,
  label,
  partyTokens,
}: {
  item: MemberUsageGroup;
  first: boolean;
  label: MemberLabel;
  partyTokens: number;
}) {
  const totals = summarizeShareUsage(item.models);
  const turns = item.models.reduce((sum, model) => sum + model.turns, 0);
  const input = item.models.reduce((sum, model) => sum + model.inputTokens, 0);
  const output = item.models.reduce((sum, model) => sum + model.outputTokens, 0);
  const used = totals.tokens > 0 || turns > 0;
  const share = used && partyTokens > 0 ? Math.round((totals.tokens / partyTokens) * 100) : null;
  const Icon = item.memberKey === null ? History : Monitor;
  return (
    <tbody
      data-testid="provider-usage-member"
      data-member-key={item.memberKey ?? ''}
      // 模型行收紧、整组底部留一点空：一眼看出这几行属于上面那台电脑。
      className={cn(
        '[font-variant-numeric:tabular-nums] [&>tr:last-child>td]:pb-2.5',
        !first && 'border-t border-[var(--border-default)]',
      )}
    >
      <tr className={used ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}>
        <td className="pb-1 pr-3 pt-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <Icon size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
            <span className={cn('truncate', used && 'font-medium')}>{label.name}</span>
            {label.source && <span className="shrink-0 text-[var(--text-secondary)]">{label.source}</span>}
            {share !== null && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[var(--text-secondary)]">
                <span aria-hidden="true" className="h-1 w-12 overflow-hidden rounded-full bg-[var(--surface-chip)]">
                  <span
                    className="block h-full rounded-full bg-[var(--text-secondary)]"
                    style={{ width: `${Math.max(share, 2)}%` }}
                  />
                </span>
                <span className="w-8 text-right">{`${share}%`}</span>
              </span>
            )}
          </span>
        </td>
        <td className={cn('pb-1 pr-3 pt-2.5 text-right', used && 'font-medium')}>{used ? turns : '—'}</td>
        <td className={cn('pb-1 pr-3 pt-2.5 text-right', used && 'font-medium')}>{used ? formatShareTokens(input) : '—'}</td>
        <td className={cn('pb-1 pr-3 pt-2.5 text-right', used && 'font-medium')}>{used ? formatShareTokens(output) : '—'}</td>
        <td className={cn('pb-1 pt-2.5 text-right', used && 'font-medium')}>
          {used && totals.amount ? formatShareMoney(totals.amount) : '—'}
        </td>
      </tr>
      {item.models.map((model) => (
        <tr key={`${model.kind}:${model.providerId ?? ''}:${model.model}`} className="text-[var(--text-secondary)]">
          {/* 模型行收紧(py-1)，缩进与上一行的电脑名对齐：图标 14 + gap-2。 */}
          <td className="py-1 pl-[22px] pr-3">{formatModelShort(model.model)}</td>
          <td className="py-1 pr-3 text-right">{model.turns}</td>
          <td className="py-1 pr-3 text-right">{formatShareTokens(model.inputTokens)}</td>
          <td className="py-1 pr-3 text-right">{formatShareTokens(model.outputTokens)}</td>
          <td className="py-1 text-right">{model.amount ? formatShareMoney(model.amount) : '—'}</td>
        </tr>
      ))}
    </tbody>
  );
}

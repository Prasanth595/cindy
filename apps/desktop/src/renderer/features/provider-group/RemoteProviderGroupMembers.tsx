/**
 * 另一台电脑上的供应商组，只读(docs/product-rules/provider-groups.md §10)：设置页里同账号另一台电脑的
 * 供应商被建成了组时，详情里列出组内电脑与它们的状态(在线、正在运行几个任务、冷却到何时)。
 * 组的设置只能在组所在电脑上改。状态没有推送，打开期间定时重读。
 */
import { ChevronRight, Monitor } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';

import { readProviderGroupAppVersion } from '../../../shared/providerGroup';
import type {
  ProviderGroupConfig,
  ProviderGroupMember,
  ProviderGroupMemberStatus,
  ProviderGroupView,
} from '../../../shared/providerGroup';
import { providerShareComputerName, useProviderShareOwnerNameOf } from '../provider-share/providerShareNames';
import { GroupMemberQuota, groupMemberQuotaTarget } from './GroupMemberQuota';
import { GroupMemberDetailsButton, GroupMemberVersion } from './GroupMemberVersion';
import { memberStatusText } from './ProviderGroupSection';

const REFRESH_INTERVAL_MS = 15_000;

function useRemoteProviderGroupView(deviceId: string, providerId: string) {
  const [view, setView] = useState<ProviderGroupView | null>(null);
  const [versions, setVersions] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    const owner = getDataOwnerGeneration();
    const canApply = () => current === seq.current && isDataOwnerGenerationCurrent(owner);
    // 旧组所在电脑不回 appVersion；查看端已有的同账号设备目录仍能提供版本。
    // 与状态独立读取，设备目录慢或失败时不挡住组状态，也不为此增加一套轮询。
    const readVersions = async () => {
      try {
        const { devices } = await window.electronAPI.deviceLink.listDevices();
        if (!canApply()) return;
        const next = new Map<string, string>();
        for (const device of devices) {
          const version = readProviderGroupAppVersion(device.appVersion);
          if (version) next.set(device.deviceId, version);
        }
        setVersions(next);
      } catch {
        if (canApply()) setVersions(new Map());
      }
    };
    void readVersions();
    try {
      const next = await window.electronAPI.providerGroup.command({ action: 'remote-view', deviceId, providerId });
      if (!canApply()) return;
      setView(next);
      setFailed(false);
    } catch {
      if (!canApply()) return;
      setFailed(true);
    }
  }, [deviceId, providerId]);

  useEffect(() => {
    setView(null);
    setVersions(new Map());
    setFailed(false);
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      seq.current += 1;
    };
  }, [reload]);

  return { view, versions, failed };
}

export function RemoteProviderGroupMembers({
  deviceId,
  providerId,
  config,
}: {
  deviceId: string;
  providerId: string;
  /** 目录里带的组设置：状态还没读到时先按它列出组内电脑。 */
  config: ProviderGroupConfig;
}) {
  const { t } = useTranslation();
  const { view, versions, failed } = useRemoteProviderGroupView(deviceId, providerId);
  const members = view?.config?.members ?? config.members;
  return (
    <section
      data-testid="remote-provider-group-members"
      className="shrink-0 border-t px-5 py-3"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <h3 className="pb-2 text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
        {t('settings.providers.remote.groupMembersTitle')}
      </h3>
      <div className="overflow-hidden rounded-lg border border-[var(--settings-theme-card-border)]">
        {members.map((member, index) => (
          <MemberRow
            key={member.key}
            member={member}
            status={view?.members.find((m) => m.key === member.key)}
            // local 指组所在电脑，不是查看端；分享来源不能按同账号设备查版本。
            appVersion={member.kind === 'local' ? versions.get(deviceId)
              : member.kind === 'device' && member.agentDeviceId ? versions.get(member.agentDeviceId) : undefined}
            first={index === 0}
            ownerDeviceId={deviceId}
          />
        ))}
      </div>
      {failed && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t('settings.providers.remote.groupMembersFailed')}
        </p>
      )}
    </section>
  );
}

function MemberRow({
  member,
  status,
  appVersion,
  first,
  ownerDeviceId,
}: {
  member: ProviderGroupMember;
  status: ProviderGroupMemberStatus | undefined;
  appVersion?: string;
  first: boolean;
  /** 组所在电脑：组里的「组所在电脑自己」读它的账号额度。 */
  ownerDeviceId: string;
}) {
  const { t, i18n } = useTranslation();
  const ownerNameOf = useProviderShareOwnerNameOf();
  // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
  const ownerName = member.kind === 'share' ? (status?.ownerName ?? ownerNameOf(member.agentDeviceId)) : null;
  const label = member.kind === 'share'
    ? providerShareComputerName(t, ownerName)
    : (status?.label ?? member.label ?? member.key);
  const source = member.kind === 'local'
    ? t('providerGroup.member.sourceGroupOwner')
    : member.kind === 'device'
      ? t('providerGroup.member.sourceDevice')
      : t('providerGroup.member.sourceShare', { name: ownerName ?? '' });
  // 组所在电脑看它能用，这台电脑却连不上(换电脑时会跳过它)：不显示成能用。
  const unreachableHere = status?.unreachableHere === true;
  const ready = !unreachableHere && (status?.state === 'available' || status?.state === 'full');
  const running = status?.running ?? 0;
  const appendRunning = running > 0 && status != null
    && (unreachableHere || (status.state !== 'available' && status.state !== 'full'));
  // 点这一行展开这台的剩余额度(2026-10-10 用户要求)；收起时不读。
  const [quotaOpen, setQuotaOpen] = useState(false);
  const quotaId = useId();
  const selfDeviceId = useOptionalAuthDeviceId();
  const versionStatus = status?.appVersion ? status : appVersion ? { ...status, appVersion } : status;
  return (
    <div
      data-testid="remote-provider-group-member"
      data-member-state={status?.state ?? 'loading'}
      data-unreachable-here={unreachableHere || undefined}
      className={cn(!first && 'border-t border-[var(--settings-theme-card-border)]')}
    >
      <GroupMemberDetailsButton
        status={versionStatus}
        type="button"
        aria-expanded={quotaOpen}
        aria-controls={quotaOpen ? quotaId : undefined}
        onClick={() => setQuotaOpen((open) => !open)}
        className="group flex w-full items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
        >
          <Monitor size={14} />
        </span>
        <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', member.paused && 'opacity-60')}>
          <span className="flex min-w-0 flex-wrap items-baseline gap-2 text-13">
            <span className="truncate font-medium text-[var(--text-primary)]">{label}</span>
            <GroupMemberVersion status={versionStatus} />
            <span className="text-12 text-[var(--text-secondary)]">{source}</span>
            <ChevronRight
              aria-hidden="true"
              size={14}
              className={cn(
                'shrink-0 self-center text-[var(--text-tertiary)] transition-transform group-hover:text-[var(--text-secondary)]',
                quotaOpen && 'rotate-90',
              )}
            />
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-12 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: ready ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)' }}
            />
            <span>
              {unreachableHere
                ? t('providerGroup.member.status.unreachableHere')
                : memberStatusText(t, status, i18n.language)}
            </span>
            {appendRunning && (
              <>
                <span aria-hidden="true">·</span>
                <span className="[font-variant-numeric:tabular-nums]">
                  {t('providerGroup.member.runningCount', { count: running })}
                </span>
              </>
            )}
          </span>
        </span>
      </GroupMemberDetailsButton>
      {quotaOpen && (
        <GroupMemberQuota
          id={quotaId}
          inset="pl-9"
          target={groupMemberQuotaTarget(member, ownerDeviceId, selfDeviceId)}
          offline={status?.state === 'offline'}
        />
      )}
    </div>
  );
}

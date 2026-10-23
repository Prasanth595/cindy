/**
 * 供应商组里一台电脑这个账号的剩余额度(docs/product-rules/provider-groups.md §10，2026-10-10 用户要求：
 * 组里展开看每台的用量)。与任务底部的用量条、供应商详情页底部的用量卡同一份数据：本机读本机账号，
 * 我的其他电脑经 device-link 查询那台的额度，OpenAI 优先原生查询。别人分享来的电脑不读：分享者的余量不对受邀者开放
 * (与任务底部用量条同一口径，见 lib/usageAccountLocation.ts)。只在展开时挂载，收起的行不读任何电脑。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
import { providerWeeklyQuotaSource } from '@/components/new-chat/useProviderWeeklyQuota';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';

import type { ProviderGroupMember } from '../../../shared/providerGroup';

/** 这台电脑的额度从哪读。 */
export type GroupMemberQuotaTarget =
  | { kind: 'local'; providerId: string }
  | { kind: 'device'; deviceId: string; providerId: string }
  | { kind: 'share' };

/** 读了这么久还没有额度就不再写「正在读取」：那台可能较旧或这个账号暂时没有额度数据。 */
const LOADING_GRACE_MS = 8_000;
type QuotaRelayStatus = 'stopped' | 'connecting' | 'online';

export function GroupMemberQuota({
  id,
  target,
  offline,
  inset = 'pl-11',
}: {
  id: string;
  target: GroupMemberQuotaTarget;
  /** 组里报这台不在线：设备在线状态尚未恢复时不去读，直接说明。 */
  offline: boolean;
  /** 左侧缩进，让卡片内容与行里的电脑名对齐(卡片自带 16px 内边距)。 */
  inset?: string;
}) {
  const { t } = useTranslation();
  // Keep observing presence while offline, independently of quota/provider hooks.
  // The group's cached status can lag a reconnect; the shared device list lets
  // quota reads recover without waiting for that cache and the next group poll.
  const devices = useDeviceLinkDeviceList();
  const targetDeviceId = target.kind === 'device' ? target.deviceId : null;
  const remoteTarget = target.kind === 'device';
  const owner = getDataOwnerGeneration();
  const [relay, setRelay] = useState<{ owner: typeof owner; status: QuotaRelayStatus } | null>(null);
  const relayRef = useRef<typeof relay>(null);
  const [presence, setPresence] = useState<{
    deviceId: string;
    directory: typeof devices;
    owner: typeof owner;
    online: boolean;
    remoteControlEnabled: boolean;
  } | null>(null);
  useEffect(() => {
    const deviceLink = window.electronAPI?.deviceLink;
    if (!deviceLink) return;
    let disposed = false;
    let revision = 0;
    const apply = (status: QuotaRelayStatus) => {
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      relayRef.current = { owner, status };
      setRelay(relayRef.current);
      if (status !== 'online') setPresence(null);
    };
    // Subscribe before reading: a newer push must beat a delayed initial reply.
    const offStatus = deviceLink.onStatusChanged?.(({ status }) => {
      revision++;
      apply(status);
    });
    if (remoteTarget) {
      void deviceLink.getState?.().then(state => {
        if (revision === 0) apply(state.linkStatus);
      }).catch(() => undefined);
    }
    return () => { disposed = true; offStatus?.(); };
  }, [owner, remoteTarget]);
  useEffect(() => {
    setPresence(null);
    const deviceLink = window.electronAPI?.deviceLink;
    if (!deviceLink) return;
    const offPresence = targetDeviceId ? deviceLink.onPresenceChanged?.((snapshot) => {
      const currentRelay = relayRef.current;
      if (
        snapshot.deviceId !== targetDeviceId || !isDataOwnerGenerationCurrent(owner) ||
        (currentRelay && isDataOwnerGenerationCurrent(currentRelay.owner) && currentRelay.status !== 'online')
      ) return;
      setPresence({
        deviceId: targetDeviceId, directory: devices, owner,
        online: snapshot.online, remoteControlEnabled: snapshot.remoteControlEnabled,
      });
    }) : undefined;
    return () => { offPresence?.(); };
  }, [targetDeviceId, devices, owner]);
  // listDevices preserves its old array after a failed refresh. A target push
  // remains fresher until the directory changes; local control permission still
  // comes only from that directory, never from a remote online announcement.
  const currentPresence = presence?.deviceId === targetDeviceId && presence.directory === devices &&
    isDataOwnerGenerationCurrent(presence.owner) ? presence : null;
  const device = target.kind === 'device' ? devices?.find((entry) => entry.deviceId === target.deviceId) : undefined;
  // A stopped relay clears the shared directory to null. Keep the stop signal
  // across that update instead of falling back to a stale online group row.
  const relayStatus = relay && isDataOwnerGenerationCurrent(relay.owner) ? relay.status : null;
  const quotaOffline = (remoteTarget && relayStatus === 'stopped') || (device
    ? !(currentPresence?.online ?? device.online) ||
      !(currentPresence?.remoteControlEnabled ?? device.remoteControlEnabled) || !device.controlEnabled
    : offline);
  // Unknown initial state cannot authorize a remote read from a cached group row.
  const remoteDeviceId = target.kind === 'device' && relayStatus !== null && !quotaOffline ? target.deviceId : null;
  const { providers: localProviders } = useProviders();
  const deviceCatalog = useDeviceProviders(remoteDeviceId ?? undefined);
  const provider =
    quotaOffline
      ? undefined
      : target.kind === 'local'
        ? localProviders.find((entry) => entry.id === target.providerId)
        : target.kind === 'device' && remoteDeviceId
          ? deviceCatalog.providers.find((entry) => entry.id === target.providerId)
          : undefined;
  const card = useDeviceProviderSubscriptionCard(provider, remoteDeviceId, { live: true });
  const [waitedOut, setWaitedOut] = useState(false);
  const waitKey = target.kind === 'share' ? '' : `${remoteDeviceId ?? ''}\n${target.providerId}`;
  useEffect(() => {
    setWaitedOut(false);
    const timer = window.setTimeout(() => setWaitedOut(true), LOADING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [waitKey]);

  let note: string | null = null;
  if (target.kind === 'share') note = t('providerGroup.member.quota.share');
  else if (quotaOffline) note = t('providerGroup.member.quota.offline');
  else if (!card) {
    if (provider && !providerWeeklyQuotaSource({ ...provider, suspended: false })) {
      note = t('providerGroup.member.quota.none');
    } else if (waitedOut || (target.kind === 'device' && deviceCatalog.error)) {
      note = t('providerGroup.member.quota.unavailable');
    } else {
      note = t('providerGroup.member.quota.loading');
    }
  }

  return (
    // 紧贴在电脑这一行下面：行本身已说明是哪台电脑，卡片不再出「Claude · 套餐」标题行。
    <div id={id} data-testid="provider-group-member-quota" className={cn('-mt-1', inset)}>
      {card ? (
        <QuotaHoverCard variant="embedded" hideIdentity account={card} />
      ) : (
        <p className="px-4 pb-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">{note}</p>
      )}
    </div>
  );
}

/**
 * 组内一台电脑的额度从哪读。`ownerDeviceId` 是组所在电脑(null = 本机的组)，`selfDeviceId` 是本机：
 * 组里的「组所在电脑自己」读组所在电脑，组员就是本机时读本机账号。
 */
export function groupMemberQuotaTarget(
  member: Pick<ProviderGroupMember, 'kind' | 'agentDeviceId' | 'providerId'>,
  ownerDeviceId: string | null,
  selfDeviceId: string | null,
): GroupMemberQuotaTarget {
  if (member.kind === 'share') return { kind: 'share' };
  const deviceId = member.kind === 'local' ? ownerDeviceId : member.agentDeviceId;
  if (!deviceId || deviceId === selfDeviceId) return { kind: 'local', providerId: member.providerId };
  return { kind: 'device', deviceId, providerId: member.providerId };
}

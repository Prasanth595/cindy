import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import {
  useAccountUsage,
  requestCodexAccountRefresh,
  type RateLimitSnapshot,
} from '@/hooks/useAccountUsage';
import { useCodexRateLimits, requestCodexRateLimitsRefresh } from '@/hooks/useCodexRateLimits';
import {
  useClaudeSubscriptionUsage,
  requestClaudeSubscriptionRefresh,
} from '@/hooks/useClaudeSubscriptionUsage';
import {
  useRemoteClaudeSubscriptionUsage,
  requestRemoteClaudeSubscriptionRefresh,
} from '@/hooks/useRemoteClaudeSubscriptionUsage';
import { useDocumentVisible } from '@/hooks/useWindowVisible';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import {
  selectRemoteCodexAccountUsage,
  useRemoteCodexAccountUsage,
  useRemoteCodexRateLimits,
  useRemoteXaiSubscriptionUsage,
  requestRemoteCodexAccountRefresh,
  requestRemoteCodexRateLimitsRefresh,
  requestRemoteXaiSubscriptionRefresh,
} from '@/hooks/useRemoteDeviceUsage';
import {
  useXaiSubscriptionUsage,
  requestXaiSubscriptionRefresh,
} from '@/hooks/useXaiSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';
import { providerWeeklyQuotaSource } from '../new-chat/useProviderWeeklyQuota';
import {
  buildClaudeUsageCard,
  buildCodexUsageCard,
  buildXaiUsageCard,
  type UsageCardAccount,
} from '../status/usageCardModel';

/** Same account/card semantics as the task card; never use a model-specific bucket
 * as the generic account quota or borrow data from another provider connection. */
export function buildSettingsCodexUsageCard(
  snapshot: MobileCodexRateLimitsResult | null,
  account: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
  locale?: string,
): UsageCardAccount {
  const direct = snapshot
    ? matchCodexBucketForModel(
        snapshot.rateLimitsByLimitId ?? {
          [snapshot.rateLimits.limitId ?? 'codex']: snapshot.rateLimits,
        },
        undefined,
        nowMs,
      )
    : null;
  // A populated bucket table is authoritative, including an empty generic slot.
  const quota =
    snapshot?.rateLimitsByLimitId != null
      ? direct
      : direct?.primary || direct?.secondary
        ? direct
        : account;
  const planType = [snapshot?.account.planType, direct?.planType, account?.planType].find(
    (value) =>
      typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown',
  );
  return buildCodexUsageCard(
    quota || planType ? { ...quota, planType, credits: account?.credits } : null,
    null, // Reset count and expiry belong to the collapsible reset list.
    t,
    nowMs,
    locale,
  );
}

export function useProviderSubscriptionCard(
  provider?: ProviderView,
  options: { queueIfPending?: boolean } = {},
): UsageCardAccount | null {
  const { t, i18n } = useTranslation();
  // Suspension only disables routing; settings must still show the saved account.
  const source = provider ? providerWeeklyQuotaSource({ ...provider, suspended: false }) : null;
  const providerId = provider?.id ?? 'openai';
  const { snapshot } = useCodexRateLimits(source === 'codex', providerId, options);
  const account = useAccountUsage(
    undefined,
    source === 'codex' ? 'codex' : undefined,
    'app-server',
    undefined,
    providerId,
  );
  const claude = useClaudeSubscriptionUsage(source === 'claude', providerId);
  const xai = useXaiSubscriptionUsage(source === 'xai', providerId);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [source]);
  useEffect(() => {
    if (source === 'xai' && !isXaiWeeklyUsageCurrent(xai, nowMs)) requestXaiSubscriptionRefresh(providerId);
  }, [source, xai, nowMs, providerId]);
  if (source === 'codex' && (snapshot || account))
    return buildSettingsCodexUsageCard(
      snapshot,
      account,
      t,
      nowMs,
      i18n?.resolvedLanguage ?? i18n?.language,
    );
  if (source === 'claude' && claude) return buildClaudeUsageCard(claude, t);
  if (source === 'xai' && xai) return buildXaiUsageCard(xai, null, t, nowMs);
  return null;
}

/**
 * 同账号另一台电脑上一个供应商连接的订阅额度卡：OpenAI 主动查询那台的原生额度，镜像仅作兜底。
 * 按电脑 + 供应商分开缓存，不借用本机同名账号；与本机卡片共用通用额度桶的选择。
 */
function useRemoteProviderSubscriptionCard(
  provider: ProviderView | undefined,
  deviceId: string | null,
): UsageCardAccount | null {
  const { t, i18n } = useTranslation();
  const source = provider && deviceId ? providerWeeklyQuotaSource({ ...provider, suspended: false }) : null;
  const providerId = provider?.id ?? 'openai';
  const codex = useRemoteCodexAccountUsage(source === 'codex' ? deviceId : null, providerId);
  const limits = useRemoteCodexRateLimits(source === 'codex' ? deviceId : null, providerId);
  const claude = useRemoteClaudeSubscriptionUsage(source === 'claude' ? deviceId : null, providerId);
  const xai = useRemoteXaiSubscriptionUsage(source === 'xai' ? deviceId : null, providerId);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [source]);
  if (source === 'codex') {
    const account = selectRemoteCodexAccountUsage(codex, 'app-server');
    return limits || account
      ? buildSettingsCodexUsageCard(limits, account, t, nowMs, i18n?.resolvedLanguage ?? i18n?.language)
      : null;
  }
  if (source === 'claude' && claude) return buildClaudeUsageCard(claude, t);
  if (source === 'xai' && xai) return buildXaiUsageCard(xai, null, t, nowMs);
  return null;
}

/** 一个供应商连接的订阅额度卡；展开的组成员用 live 开启前台刷新，收起卸载时停止。 */
export function useDeviceProviderSubscriptionCard(
  provider: ProviderView | undefined,
  deviceId: string | null,
  options: { live?: boolean } = {},
): UsageCardAccount | null {
  const visible = useDocumentVisible(options.live === true);
  const active = !options.live || visible;
  const activeProvider = active ? provider : undefined;
  const source = activeProvider
    ? providerWeeklyQuotaSource({ ...activeProvider, suspended: false })
    : null;
  const providerId = activeProvider?.id;
  const epoch = useDeviceLinkReconnectEpoch(
    options.live && source ? deviceId ?? undefined : undefined,
  );
  const previousEpoch = useRef(epoch);
  const local = useProviderSubscriptionCard(deviceId === null ? activeProvider : undefined, {
    queueIfPending: options.live === true,
  });
  const remote = useRemoteProviderSubscriptionCard(
    deviceId === null ? undefined : activeProvider,
    deviceId,
  );
  useEffect(() => {
    if (!options.live || !source || !providerId) return;
    const timer = window.setInterval(
      () => refreshSubscriptionCard(source, providerId, deviceId, false, { background: true }),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [options.live, source, providerId, deviceId]);
  useEffect(() => {
    const reconnected = previousEpoch.current !== epoch;
    previousEpoch.current = epoch;
    // Mirrors own mount/resume reads, including queuing behind an old pending
    // read. Only a reconnect observed while mounted needs another refresh here.
    if (reconnected && options.live && source && providerId && deviceId) {
      refreshSubscriptionCard(source, providerId, deviceId, true);
    }
  }, [options.live, source, providerId, deviceId, epoch]);
  return deviceId === null ? local : remote;
}

function refreshSubscriptionCard(
  source: NonNullable<ReturnType<typeof providerWeeklyQuotaSource>>,
  providerId: string,
  deviceId: string | null,
  queueIfPending = false,
  scheduling?: { background?: boolean },
): void {
  if (deviceId) {
    if (source === 'codex') {
      requestRemoteCodexRateLimitsRefresh(deviceId, providerId, queueIfPending, scheduling);
      requestRemoteCodexAccountRefresh(deviceId, providerId, queueIfPending, scheduling);
    } else if (source === 'claude') {
      requestRemoteClaudeSubscriptionRefresh(deviceId, providerId, queueIfPending, scheduling);
    } else requestRemoteXaiSubscriptionRefresh(deviceId, providerId, queueIfPending, scheduling);
  } else if (source === 'codex') {
    requestCodexRateLimitsRefresh(providerId);
    requestCodexAccountRefresh(providerId);
  } else if (source === 'claude') requestClaudeSubscriptionRefresh(providerId);
  else requestXaiSubscriptionRefresh(providerId);
}

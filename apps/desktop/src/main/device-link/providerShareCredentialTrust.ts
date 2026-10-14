/**
 * 受邀者对某个分享打开的「凭证操作总是允许」(provider-sharing.md §9 第 7 条，2026-10-15 用户确认)。
 *
 * 每台电脑、每个 Cindy 账号各自保存一份；缺席 = 关闭，凭证操作照旧逐次确认(卡上仍可选「本任务总是允许」)。
 * 打开后，这个分享的所有任务读写凭证类文件、执行读取凭证的命令都不再弹确认卡，按任务自己的权限档处理；
 * 关闭不收回任务里单独选过的「本任务总是允许」。
 *
 * 只记分享 id、打开时的成员 id 与分享所在区域，不含任何凭证。退出分享、分享从已确认完整的名单里消失，
 * 或成员 id 变了(重新申请加入)时失效，需要重新打开。
 */
import type { ProviderShareReceived } from '@cindy/device-link';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

type Region = ProviderShareReceived['owner']['region'];

interface TrustedShare {
  memberId: string;
  region: Region;
}

interface CredentialTrustPrefs {
  trustedShares: Record<string, TrustedShare>;
}

const DEFAULTS: CredentialTrustPrefs = { trustedShares: {} };
const MAX_ENTRIES = 512;
const MAX_ID_LENGTH = 128;
const log = createLogger('provider-share:credential-trust');

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function normalize(raw: unknown): CredentialTrustPrefs {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { trustedShares?: unknown }).trustedShares
      : undefined;
  const trustedShares: Record<string, TrustedShare> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [shareId, entry] of Object.entries(source as Record<string, unknown>)) {
      if (Object.keys(trustedShares).length >= MAX_ENTRIES) break;
      if (!validId(shareId) || !entry || typeof entry !== 'object') continue;
      const { memberId, region } = entry as { memberId?: unknown; region?: unknown };
      if (!validId(memberId) || (region !== 'cn' && region !== 'global')) continue;
      trustedShares[shareId] = { memberId, region };
    }
  }
  return { trustedShares };
}

const store = createOverrideSettingsFile<CredentialTrustPrefs>({
  filePath: () => ownerScopedUserDataPath('provider-share-credential-trust.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'provider-share-credential-trust',
  maxBytes: 256 * 1024,
});

/**
 * 这个分享当前是否打开了「凭证操作总是允许」。执行器每次判断凭证操作都会问(搜索时逐个文件)，
 * 只读内存里的缓存；这份文件只由本进程写。
 */
export function isProviderShareCredentialTrusted(share: Pick<ProviderShareReceived, 'shareId' | 'memberId'>): boolean {
  const entry = store.read().trustedShares[share.shareId];
  return entry !== undefined && entry.memberId === share.memberId;
}

export function setProviderShareCredentialTrusted(share: ProviderShareReceived, trusted: boolean): void {
  const trustedShares = { ...store.read().trustedShares };
  if (trusted) {
    const current = trustedShares[share.shareId];
    if (current?.memberId === share.memberId && current.region === share.owner.region) return;
    if (!current && Object.keys(trustedShares).length >= MAX_ENTRIES) {
      throw new Error('provider share credential trust limit reached');
    }
    trustedShares[share.shareId] = { memberId: share.memberId, region: share.owner.region };
  } else {
    if (!(share.shareId in trustedShares)) return;
    delete trustedShares[share.shareId];
  }
  store.writePatch({ trustedShares });
  log.info('provider share credential trust updated', { shareId: share.shareId, trusted });
}

/** 退出分享后删掉，重新加入要重新打开。 */
export function forgetProviderShareCredentialTrust(shareId: string): void {
  const trustedShares = { ...store.read().trustedShares };
  if (!(shareId in trustedShares)) return;
  delete trustedShares[shareId];
  store.writePatch({ trustedShares });
  log.info('provider share credential trust removed', { shareId, reason: 'left' });
}

/**
 * 已收到的分享名单变化后调用：名单完整的区域里已经不在的分享(被删除、被移出)删掉记录。
 * 名单没确认完整的区域(对方区域还没读到等)一律保留，不把「没读到」当成「已删除」。
 */
export function pruneProviderShareCredentialTrust(
  received: readonly ProviderShareReceived[],
  confirmedRegions: readonly Region[],
): void {
  const current = store.read().trustedShares;
  const present = new Set(received.map((share) => share.shareId));
  const removed = Object.entries(current)
    .filter(([shareId, entry]) => confirmedRegions.includes(entry.region) && !present.has(shareId))
    .map(([shareId]) => shareId);
  if (removed.length === 0) return;
  const trustedShares = { ...current };
  for (const shareId of removed) delete trustedShares[shareId];
  store.writePatch({ trustedShares });
  log.info('provider share credential trust removed', { shareIds: removed, reason: 'share-gone' });
}

export const __testing = { normalize };

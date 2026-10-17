/**
 * 组内电脑撞到用量上限后的冷却(docs/product-rules/provider-groups.md §5)：按账号存在本机
 * (`provider-group-cooling.json`)，重启后照样避开，不会一启动又先去试撞了上限的那台。
 * 只存还没到期的；其余失败(连不上、起不来等)只在本次运行内记。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { isProviderGroupProviderId, PROVIDER_GROUP_STORAGE_MEMBER_CAP } from '../../shared/providerGroup.js';
import type { ProviderGroupPersistedCooling } from './router.js';

interface CoolingFile {
  cooling: ProviderGroupPersistedCooling;
}

const MEMBER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;
/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_PROVIDERS = 1024;

function normalize(raw: unknown): CoolingFile {
  const source = (raw as Partial<CoolingFile> | null)?.cooling;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { cooling: {} };
  const cooling: ProviderGroupPersistedCooling = {};
  for (const [providerId, members] of Object.entries(source)) {
    if (Object.keys(cooling).length >= MAX_PROVIDERS) break;
    if (!isProviderGroupProviderId(providerId) || !members || typeof members !== 'object' || Array.isArray(members)) continue;
    const entries: Record<string, number> = {};
    for (const [memberKey, until] of Object.entries(members as Record<string, unknown>)) {
      if (Object.keys(entries).length >= PROVIDER_GROUP_STORAGE_MEMBER_CAP) break;
      if (!MEMBER_KEY_PATTERN.test(memberKey) || typeof until !== 'number' || !Number.isFinite(until) || until <= 0) continue;
      entries[memberKey] = until;
    }
    if (Object.keys(entries).length > 0) cooling[providerId] = entries;
  }
  return { cooling };
}

const log = desktopMakerLogger.child('provider-group');
const store = createOverrideSettingsFile<CoolingFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-cooling.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { cooling: {} },
  normalize,
  log,
  label: 'provider-group-cooling',
  maxBytes: 1024 * 1024,
});

export function readProviderGroupCooling(): ProviderGroupPersistedCooling {
  store.invalidateIfChanged();
  return store.read().cooling;
}

/**
 * 在锁内和所在文件当前内容合并(按 provider + 成员取较晚的结束时间)，不直接用调用方
 * 快照覆盖：连续冷却两台电脑时，早开始、后步拿到文件锁的写入不应该把已落地的那一台挤丢
 * (greptile-apps P1, PR #5792 review)。合并时移除到期记录，避免旧成员永久占满存储边界。
 */
function mergeCooling(
  current: ProviderGroupPersistedCooling,
  next: ProviderGroupPersistedCooling,
  now = Date.now(),
): ProviderGroupPersistedCooling {
  const merged: ProviderGroupPersistedCooling = {};
  for (const providerId of new Set([...Object.keys(current), ...Object.keys(next)])) {
    const a = current[providerId] ?? {};
    const b = next[providerId] ?? {};
    const entries: Record<string, number> = {};
    for (const memberKey of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const until = Math.max(a[memberKey] ?? 0, b[memberKey] ?? 0);
      if (until > now) entries[memberKey] = until;
    }
    if (Object.keys(entries).length > 0) merged[providerId] = entries;
  }
  return merged;
}

/** 合并写入(调用方只给还没到期的)；写不下去只记日志，本次运行照常避开。 */
export function writeProviderGroupCooling(cooling: ProviderGroupPersistedCooling): void {
  void store.updateAtomic((current) => normalize({ cooling: mergeCooling(current.value.cooling, cooling) })).catch((error: unknown) => {
    log.warn('provider group: saving cooldowns failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

export const __testing = { normalize, mergeCooling };

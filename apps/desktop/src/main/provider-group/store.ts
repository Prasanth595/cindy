/**
 * 供应商组设置：按账号存在本机(`provider-group-prefs.json`)，不同步到其他电脑。
 * 组只是「这台电脑上这个供应商」的一项设置，没有账号级的组(docs/product-rules/provider-groups.md §3)。
 */
import { randomUUID } from 'node:crypto';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import {
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupConfig,
} from '../../shared/providerGroup.js';

interface ProviderGroupFile {
  groups: Record<string, ProviderGroupConfig>;
  /** 分享来的电脑离开全部组后，等空名单确认再删除；代次防止迟到确认吞掉再次移出的清理。 */
  reshareCleanups?: Record<string, string>;
}

/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_GROUPS = 1024;

function normalize(raw: unknown): ProviderGroupFile {
  const source = raw as Partial<ProviderGroupFile> | null;
  const groups = source?.groups;
  const out: Record<string, ProviderGroupConfig> = {};
  for (const [providerId, value] of Object.entries(groups && typeof groups === 'object' && !Array.isArray(groups) ? groups : {})) {
    if (Object.keys(out).length >= MAX_GROUPS) break;
    if (!isProviderGroupProviderId(providerId)) continue;
    const config = normalizeProviderGroupConfig(value, providerId);
    if (config) out[providerId] = config;
  }
  const reshareCleanups: Record<string, string> = {};
  if (source?.reshareCleanups && typeof source.reshareCleanups === 'object' && !Array.isArray(source.reshareCleanups)) {
    for (const [device, token] of Object.entries(source.reshareCleanups)) {
      if (/^share:[A-Za-z0-9_.:-]{1,128}$/.test(device) && typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token)) {
        reshareCleanups[device] = token;
      }
    }
  }
  return { groups: out, ...(Object.keys(reshareCleanups).length > 0 ? { reshareCleanups } : {}) };
}

/** 同一分享可能同时加入几个组；最后一个引用移出时才清空这台电脑的转分享名单。 */
function sharedDevices(groups: Record<string, ProviderGroupConfig>): Set<string> {
  return new Set(Object.values(groups).flatMap((config) => config.members
    .filter((member) => member.kind === 'share' && member.agentDeviceId)
    .map((member) => member.agentDeviceId!)));
}

const log = desktopMakerLogger.child('provider-group');
const store = createOverrideSettingsFile<ProviderGroupFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-prefs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { groups: {} },
  normalize,
  log,
  label: 'provider-group',
  maxBytes: 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

export function readProviderGroup(providerId: string): ProviderGroupConfig | null {
  if (!isProviderGroupProviderId(providerId)) return null;
  store.invalidateIfChanged();
  return store.read().groups[providerId] ?? null;
}

export function listProviderGroups(): Record<string, ProviderGroupConfig> {
  store.invalidateIfChanged();
  return store.read().groups;
}

/** 写入一个供应商的组；config 校正后没有组内电脑即删除这个组。返回落盘后的值。 */
export async function writeProviderGroup(
  providerId: string,
  config: unknown,
): Promise<ProviderGroupConfig | null> {
  if (!isProviderGroupProviderId(providerId)) throw new Error('Invalid provider id');
  const normalized = config === null ? null : normalizeProviderGroupConfig(config, providerId);
  const next = await store.updateAtomic(({ value }) => {
    const groups = { ...value.groups };
    if (normalized) groups[providerId] = normalized;
    else delete groups[providerId];
    const remaining = sharedDevices(groups);
    const reshareCleanups = { ...value.reshareCleanups };
    for (const device of sharedDevices(value.groups)) {
      if (!remaining.has(device)) reshareCleanups[device] = randomUUID();
    }
    // 与移出组同一把锁、同一次原子替换：崩溃、离线、重新加入都不能丢掉清空旧同意的意图。
    return { groups, reshareCleanups };
  });
  return next.groups[providerId] ?? null;
}

/** 在同一把写锁内基于最新组配置做最小更新；更新器返回 undefined 表示放弃写入。 */
export async function updateProviderGroup(
  providerId: string,
  updater: (current: ProviderGroupConfig | null) => ProviderGroupConfig | null | undefined,
): Promise<ProviderGroupConfig | null> {
  if (!isProviderGroupProviderId(providerId)) throw new Error('Invalid provider id');
  const next = await store.updateAtomic(({ value }) => {
    const current = value.groups[providerId] ?? null;
    const updated = updater(current);
    if (updated === undefined) return {};
    const normalized = updated === null ? null : normalizeProviderGroupConfig(updated, providerId);
    if (updated !== null && !normalized) throw new Error('Invalid provider group config');
    const groups = { ...value.groups };
    if (normalized) groups[providerId] = normalized;
    else delete groups[providerId];
    const remaining = sharedDevices(groups);
    const reshareCleanups = { ...value.reshareCleanups };
    for (const device of sharedDevices(value.groups)) {
      if (!remaining.has(device)) reshareCleanups[device] = randomUUID();
    }
    return { groups, reshareCleanups };
  });
  return next.groups[providerId] ?? null;
}

export function listProviderGroupReshareCleanups(): Readonly<Record<string, string>> {
  store.invalidateIfChanged();
  return store.read().reshareCleanups ?? {};
}

/** 空名单已被对端确认，只确认这次清理，保留报告期间新生成的代次。 */
export async function completeProviderGroupReshareCleanup(agentDeviceId: string, token: string): Promise<void> {
  await store.updateAtomic(({ value }) => {
    if (value.reshareCleanups?.[agentDeviceId] !== token) return {};
    const reshareCleanups = { ...value.reshareCleanups };
    delete reshareCleanups[agentDeviceId];
    return { reshareCleanups };
  });
}

export const __testing = { normalize };

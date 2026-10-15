/**
 * 供应商分享 · 转分享的同意(分享者这台电脑；docs/product-rules/provider-sharing.md §4.3)。
 *
 * 受邀者把这里分享出去的供应商加进了它自己的供应商组，又把那个组分享给了别人：组转来的受邀者任务要在这台
 * 运行，必须先由这台的主人逐人同意。受邀者的组所在电脑经远程 Agent 的 op `reshare` 把它分享的人整体报上来
 * (整体替换那台上一份)，新出现的人记成待处理；主人在「远程与分享」页同意或拒绝，之后随时可以撤回或改成同意。
 *
 * 记录按账号存在本机 `provider-share-reshare.json`，不经服务端：分享、成员与组所在电脑的设备 id、组所在电脑给的
 * 不透明键，以及它转述的昵称与头像(只用来让主人认出是谁)。成员被删除或退出时，删掉它名下的全部记录。
 */
import { randomUUID } from 'node:crypto';

import {
  REMOTE_AGENT_RELAY_KEY_PATTERN,
  REMOTE_AGENT_RESHARE_STATES,
  parseProviderSharePeer,
  type RemoteAgentReshareEntry,
  type RemoteAgentReshareResult,
  type RemoteAgentReshareState,
} from '@cindy/device-link';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { providerShareGuestAccess } from './providerShareHost.js';

const log = createLogger('provider-share:reshare');

/** 组所在电脑(受邀者那台电脑)的身份：分享、成员与那台的设备 id(本地 peer key 里的三项)。 */
export interface ProviderShareResharePeer {
  shareId: string;
  memberId: string;
  deviceId: string;
}

export interface ProviderShareReshareRecord extends ProviderShareResharePeer {
  /** 本机给这条记录取的 id(管理页操作用)。 */
  id: string;
  /** 组所在电脑为它分享的那个人取的不透明键(打开中转任务时随载荷带来)。 */
  key: string;
  name: string;
  avatar: string | null;
  state: RemoteAgentReshareState;
  requestedAt: number;
  decidedAt?: number;
}

interface ReshareFile {
  records: ProviderShareReshareRecord[];
}

/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_RECORDS = 4096;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const RECORD_ID = /^[0-9a-f-]{36}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function avatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function normalizeRecord(raw: unknown): ProviderShareReshareRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = text(value.name, 128);
  if (
    typeof value.id !== 'string' || !RECORD_ID.test(value.id)
    || typeof value.shareId !== 'string' || !ID_PATTERN.test(value.shareId)
    || typeof value.memberId !== 'string' || !ID_PATTERN.test(value.memberId)
    || typeof value.deviceId !== 'string' || !ID_PATTERN.test(value.deviceId)
    || typeof value.key !== 'string' || !REMOTE_AGENT_RELAY_KEY_PATTERN.test(value.key)
    || !name
    || !(REMOTE_AGENT_RESHARE_STATES as readonly unknown[]).includes(value.state)
    || typeof value.requestedAt !== 'number' || !Number.isFinite(value.requestedAt)
  ) return null;
  return {
    id: value.id,
    shareId: value.shareId,
    memberId: value.memberId,
    deviceId: value.deviceId,
    key: value.key,
    name,
    avatar: avatar(value.avatar),
    state: value.state as RemoteAgentReshareState,
    requestedAt: value.requestedAt,
    ...(typeof value.decidedAt === 'number' && Number.isFinite(value.decidedAt) ? { decidedAt: value.decidedAt } : {}),
  };
}

function normalize(raw: unknown): ReshareFile {
  const source = (raw as Partial<ReshareFile> | null)?.records;
  if (!Array.isArray(source)) return { records: [] };
  const records: ProviderShareReshareRecord[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    if (records.length >= MAX_RECORDS) break;
    const record = normalizeRecord(entry);
    if (!record) continue;
    const scope = `${scopeOf(record)}\0${record.key}`;
    if (seen.has(record.id) || seen.has(scope)) continue;
    seen.add(record.id);
    seen.add(scope);
    records.push(record);
  }
  return { records };
}

function scopeOf(peer: ProviderShareResharePeer): string {
  return `${peer.shareId}\0${peer.memberId}\0${peer.deviceId}`;
}

function samePeer(record: ProviderShareResharePeer, peer: ProviderShareResharePeer): boolean {
  return record.shareId === peer.shareId && record.memberId === peer.memberId && record.deviceId === peer.deviceId;
}

const store = createOverrideSettingsFile<ReshareFile>({
  filePath: () => ownerScopedUserDataPath('provider-share-reshare.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { records: [] },
  normalize,
  log,
  label: 'provider-share-reshare',
  maxBytes: 4 * 1024 * 1024,
  // 记录里有别人的昵称与头像：不进日志。
  logLoadedValue: false,
});

function read(): ProviderShareReshareRecord[] {
  store.invalidateIfChanged();
  return store.read().records;
}

export interface ProviderShareReshareSyncResult {
  result: RemoteAgentReshareResult;
  /** 新出现、等主人处理的人。 */
  added: ProviderShareReshareRecord[];
  /** 组所在电脑不再报上来的人里已经同意过的(要结束他们经组转来的任务)。 */
  droppedApproved: ProviderShareReshareRecord[];
}

/**
 * 组所在电脑报上它此刻分享的人(整体替换这台组所在电脑上一份)：已有的人保留主人的决定，只更新昵称与头像；
 * 新出现的人记成待处理；不再报上来的人删掉(那人已不在它的分享里，或那台已把这台移出组)。
 */
export async function syncProviderShareReshare(
  peer: ProviderShareResharePeer,
  entries: readonly RemoteAgentReshareEntry[],
  now = Date.now(),
): Promise<ProviderShareReshareSyncResult> {
  const added: ProviderShareReshareRecord[] = [];
  const droppedApproved: ProviderShareReshareRecord[] = [];
  const next = await store.updateAtomic(({ value }) => {
    const wanted = new Map(entries.map((entry) => [entry.key, entry]));
    const records: ProviderShareReshareRecord[] = [];
    for (const record of value.records) {
      if (!samePeer(record, peer)) {
        records.push(record);
        continue;
      }
      const entry = wanted.get(record.key);
      if (!entry) {
        if (record.state === 'approved') droppedApproved.push(record);
        continue;
      }
      wanted.delete(record.key);
      records.push({ ...record, name: entry.name, avatar: entry.avatar ?? null });
    }
    for (const entry of wanted.values()) {
      if (records.length >= MAX_RECORDS) break;
      const record: ProviderShareReshareRecord = {
        id: randomUUID(),
        ...peer,
        key: entry.key,
        name: entry.name,
        avatar: entry.avatar ?? null,
        state: 'pending',
        requestedAt: now,
      };
      added.push(record);
      records.push(record);
    }
    return { records };
  });
  const states = new Map(next.records.filter((record) => samePeer(record, peer)).map((record) => [record.key, record.state]));
  return {
    result: {
      entries: entries.flatMap((entry) => {
        const state = states.get(entry.key);
        return state ? [{ key: entry.key, state }] : [];
      }),
    },
    // 落盘时超出存储边界没写进去的不算新增。
    added: added.filter((record) => next.records.some((item) => item.id === record.id)),
    droppedApproved,
  };
}

/** 组转来的受邀者任务能不能在这台运行：主人同意过这台组所在电脑报上来的这个人。 */
export function isProviderShareReshareApproved(peer: ProviderShareResharePeer, key: string | undefined): boolean {
  if (!key) return false;
  return read().some((record) => samePeer(record, peer) && record.key === key && record.state === 'approved');
}

/** 主人同意或拒绝(拒绝已同意的 = 撤回)。返回改动后的记录与之前的状态；记录不在了返回 null。 */
export async function decideProviderShareReshare(
  id: string,
  decision: 'approve' | 'reject',
  now = Date.now(),
): Promise<{ record: ProviderShareReshareRecord; previous: RemoteAgentReshareState } | null> {
  let changed: { record: ProviderShareReshareRecord; previous: RemoteAgentReshareState } | null = null;
  await store.updateAtomic(({ value }) => ({
    records: value.records.map((record) => {
      if (record.id !== id) return record;
      const next: ProviderShareReshareRecord = {
        ...record,
        state: decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: now,
      };
      changed = { record: next, previous: record.state };
      return next;
    }),
  }));
  return changed;
}

export function listProviderShareReshares(): readonly ProviderShareReshareRecord[] {
  return read();
}

/** 删掉匹配的记录(成员被删除或退出、分享已不在这台)。返回删掉的。 */
export async function pruneProviderShareReshares(
  match: (record: ProviderShareReshareRecord) => boolean,
): Promise<ProviderShareReshareRecord[]> {
  if (!read().some(match)) return [];
  const removed: ProviderShareReshareRecord[] = [];
  await store.updateAtomic(({ value }) => ({
    records: value.records.filter((record) => {
      if (!match(record)) return true;
      removed.push(record);
      return false;
    }),
  }));
  return removed;
}

// ─── 远程 Agent op `reshare` 与本机接线 ─────────────────────────────

export interface ProviderShareReshareEvents {
  /** 新出现、等主人处理的人(待处理一栏与系统通知)。 */
  requested(records: readonly ProviderShareReshareRecord[]): void;
  /** 记录变了(管理页重读)。 */
  changed(): void;
  /** 这些人不再被同意(撤回、组所在电脑不再报上来)：结束他们经组转来的任务。 */
  revoked(records: readonly ProviderShareReshareRecord[]): void;
}

let events: ProviderShareReshareEvents | null = null;

/** providerShareRuntime 启动时接上，停止时清掉。 */
export function setProviderShareReshareEvents(next: ProviderShareReshareEvents | null): void {
  events = next;
}

/** 受邀者对端 → 组所在电脑的身份；不是受邀者返回 null。 */
export function providerShareResharePeerOf(controller: string): ProviderShareResharePeer | null {
  const peer = parseProviderSharePeer(controller);
  return peer?.role === 'guest' ? { shareId: peer.shareId, memberId: peer.memberId, deviceId: peer.deviceId } : null;
}

/**
 * 远程 Agent 的 op `reshare`(调用方已按分享准入)：记下组所在电脑此刻分享的人，返回每个人的结果。
 * 只有受邀者能报，同账号电脑经组使用不需要同意。
 */
export async function handleProviderShareReshare(
  controller: string,
  entries: readonly RemoteAgentReshareEntry[],
): Promise<RemoteAgentReshareResult> {
  const peer = providerShareResharePeerOf(controller);
  if (!peer || !providerShareGuestAccess(controller)) throw new Error('[REMOTE_AGENT_INVALID] reshare is only for shared users');
  const synced = await syncProviderShareReshare(peer, entries);
  if (synced.droppedApproved.length > 0) events?.revoked(synced.droppedApproved);
  if (synced.added.length > 0) events?.requested(synced.added);
  else if (synced.droppedApproved.length > 0) events?.changed();
  return synced.result;
}

/** 组转来的受邀者任务能不能在这台运行(远程 Agent 打开任务时核对)。 */
export function providerShareReshareAllows(controller: string, key: string | undefined): boolean {
  const peer = providerShareResharePeerOf(controller);
  return !!peer && isProviderShareReshareApproved(peer, key);
}

export const __testing = { normalize };

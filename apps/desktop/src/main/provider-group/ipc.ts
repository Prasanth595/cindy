/**
 * 供应商组设置的 IPC：只接受本机应用窗口，不经设备互联代理(组是这台电脑上的设置)。
 */
import { ipcMain } from 'electron';

import { activeOwnerScopeKey } from '../appSessionState.js';

import {
  PROVIDER_GROUP_IPC,
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupCommand,
  type ProviderGroupConfig,
  type ProviderGroupReshareSummary,
  type ProviderGroupSessionGroup,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { broadcast, getSelfDeviceId } from '../device-link/index.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { pruneProviderGroupBindings } from './bindings.js';
import type { ProviderGroupDirectory } from './directory.js';
import type { ProviderGroupRouter } from './router.js';
import {
  getProviderGroupDirectory,
  getProviderGroupRemoteClient,
  getProviderGroupRouter,
  readProviderGroupOfSession,
} from './runtime.js';
import { listProviderGroups, readProviderGroup, writeProviderGroup } from './store.js';

const log = createLogger('provider-group');

export interface ProviderGroupCommandDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  writeGroup(providerId: string, config: unknown): Promise<ProviderGroupConfig | null>;
  /** 解除指向已不在组里的电脑的任务绑定；keep 为 null = 整个组已删除。 */
  pruneBindings(providerId: string, keep: ReadonlySet<string> | null): Promise<void>;
  /** 当前账号：等远端目录期间换了账号时不写入(否则会把上一个账号的组写进新账号)。 */
  ownerKey(): string;
  /** 另一台电脑上某个供应商的组与组内电脑状态(设置页只读展示)。 */
  remoteView(deviceId: string, providerId: string): Promise<ProviderGroupView>;
  /** 本机设备 id(另一台电脑的组里可能也有本机这台)。 */
  localDeviceId(): string | null;
  /** 本机全部组的设置(不读远端，模型列表据此收起本机组里的远程供应商)。 */
  listGroups(): Record<string, ProviderGroupConfig>;
  /** 这个任务此刻归哪个组(只读本机记录)。 */
  sessionGroup(sessionId: string): Promise<ProviderGroupSessionGroup>;
  changed(providerId: string): void;
  /**
   * 转分享(provider-sharing.md §4.3)：分享来的组内电脑的主人对本机分享出去的人逐人同意的结果，设置页据此显示；
   * 设置页打开时顺带核对一次。不提供时不显示(测试)。
   */
  reshare?: {
    summary(providerId: string, agentDeviceId: string): ProviderGroupReshareSummary | null;
    refreshIfStale(): void;
  };
}

/** 本机自己的组：分享来的组内电脑补上转分享的结果(只给本机设置页，不经设备互联发出)。 */
function withReshare(deps: ProviderGroupCommandDeps, view: ProviderGroupView): ProviderGroupView {
  const reshare = deps.reshare;
  if (!reshare || !view.config) return view;
  reshare.refreshIfStale();
  const members = view.config.members;
  return {
    ...view,
    members: view.members.map((status) => {
      const member = members.find((m) => m.key === status.key);
      if (member?.kind !== 'share' || !member.agentDeviceId) return status;
      const summary = reshare.summary(view.providerId, member.agentDeviceId);
      return summary ? { ...status, reshare: summary } : status;
    }),
  };
}

const REMOTE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseProviderGroupCommand(raw: unknown): ProviderGroupCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'command required');
  const value = raw as Record<string, unknown>;
  if (value.action === 'list') return { action: 'list' };
  if (value.action === 'session-group') {
    if (typeof value.sessionId !== 'string' || !SESSION_ID_PATTERN.test(value.sessionId)) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    return { action: 'session-group', sessionId: value.sessionId as string };
  }
  if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'providerId required');
  const providerId = value.providerId as string;
  switch (value.action) {
    case 'get':
    case 'candidates':
    case 'delete':
      return { action: value.action, providerId };
    case 'remote-view': {
      if (typeof value.deviceId !== 'string' || !REMOTE_DEVICE_ID_PATTERN.test(value.deviceId)) {
        throwIpcError('INVALID_PARAMS', 'deviceId required');
      }
      return { action: 'remote-view', providerId, deviceId: value.deviceId as string };
    }
    case 'save': {
      if (!value.config || typeof value.config !== 'object') throwIpcError('INVALID_PARAMS', 'config required');
      return { action: 'save', providerId, config: value.config as ProviderGroupConfig };
    }
    default:
      throwIpcError('INVALID_PARAMS', 'unknown provider group action');
  }
}

/** 核对这台电脑连不连得上组里某台的上限：设置页每 15 秒重读，不能让一台慢的电脑拖住整个组的状态。 */
export const PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS = 3_000;

/** 读那台的目录：读到了 true，读失败 false，到点还没结果 null(说不准，不下结论)。 */
function readsCatalog(
  directory: Pick<ProviderGroupDirectory, 'readDeviceCatalog'>,
  agentDeviceId: string,
): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    directory.readDeviceCatalog(agentDeviceId).then(() => true, () => false),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 另一台电脑上的组：状态是组所在电脑看到的。组里的「我的其他电脑」由这台电脑直接连过去(§4 同账号直连)，
 * 组所在电脑那边看它能用、这台却读不到它的目录时标出来(`unreachableHere`)：否则这里显示能用，换电脑时却总换不过去。
 * 目录有短时缓存；每台最多等 3 秒，到点还没结果的不标，照组所在电脑的状态显示。
 */
export async function markMembersUnreachableHere(
  view: ProviderGroupView,
  directory: Pick<ProviderGroupDirectory, 'readDeviceCatalog'>,
  selfDeviceId: string | null,
): Promise<ProviderGroupView> {
  if (!view.config || !selfDeviceId) return view;
  const usable = new Set(view.members.filter((m) => m.state === 'available' || m.state === 'full').map((m) => m.key));
  const direct = view.config.members.filter((m) =>
    m.kind === 'device' && usable.has(m.key) && m.agentDeviceId !== null && m.agentDeviceId !== selfDeviceId);
  if (direct.length === 0) return view;
  const reads = await Promise.all(direct.map(async (m) => ({ key: m.key, ok: await readsCatalog(directory, m.agentDeviceId!) })));
  const unreachable = new Set(reads.filter((r) => r.ok === false).map((r) => r.key));
  if (unreachable.size === 0) return view;
  return {
    ...view,
    members: view.members.map((m) => (unreachable.has(m.key) ? { ...m, unreachableHere: true } : m)),
  };
}

/** 业务体(依赖注入，单测直接调)。 */
export async function executeProviderGroupCommand(deps: ProviderGroupCommandDeps, command: ProviderGroupCommand) {
  if (command.action === 'list') return deps.listGroups();
  if (command.action === 'session-group') return deps.sessionGroup(command.sessionId);
  const { providerId } = command;
  switch (command.action) {
    case 'get':
      return withReshare(deps, await deps.router.view(providerId, { includeGuestSupport: true }));
    case 'remote-view':
      return markMembersUnreachableHere(
        await deps.remoteView(command.deviceId, providerId),
        deps.directory,
        deps.localDeviceId(),
      );
    case 'candidates':
      return deps.directory.listCandidates(providerId, deps.readGroup(providerId));
    case 'delete':
      await deps.writeGroup(providerId, null);
      await deps.pruneBindings(providerId, null);
      deps.changed(providerId);
      return deps.router.view(providerId, { includeGuestSupport: true });
    case 'save': {
      const owner = deps.ownerKey();
      const next = normalizeProviderGroupConfig(command.config, providerId);
      if (next) {
        // 新加入的电脑必须是这台电脑已经能用的同一个供应商(§3)，不能凭渲染端点名加入。
        const previous = new Set(deps.readGroup(providerId)?.members.map((m) => m.key) ?? []);
        const added = next.members.filter((m) => m.kind !== 'local' && !previous.has(m.key));
        if (added.length > 0) {
          const candidates = await deps.directory.listCandidates(providerId, deps.readGroup(providerId));
          const allowed = new Set(candidates.filter((c) => !c.blocked).map((c) => c.key));
          const rejected = added.filter((m) => !allowed.has(m.key));
          if (rejected.length > 0) {
            throwIpcError('PRECONDITION_FAILED', 'Only the same provider that this computer can already use can join the group');
          }
          // 显示名以目录为准，渲染端给的只是快照。
          const labels = new Map(candidates.map((c) => [c.key, c.label]));
          for (const member of next.members) {
            const label = labels.get(member.key);
            if (label) member.label = label;
          }
        }
      }
      if (deps.ownerKey() !== owner) {
        throwIpcError('PRECONDITION_FAILED', 'The account changed while saving the provider group');
      }
      const written = await deps.writeGroup(providerId, next);
      await deps.pruneBindings(providerId, written ? new Set(written.members.map((m) => m.key)) : null);
      deps.changed(providerId);
      return withReshare(deps, await deps.router.view(providerId, { includeGuestSupport: true }));
    }
  }
}

/**
 * 转分享(provider-sharing.md §4.3)由 bootstrap 接上(reshareRuntime.ts)：组里的电脑变了就重新报分享的人，
 * 设置页显示分享来的电脑对每个人的同意情况。
 */
export interface ProviderGroupIpcReshare {
  summary(providerId: string, agentDeviceId: string): ProviderGroupReshareSummary | null;
  refreshIfStale(): void;
  kick(reason: string): void;
}

export function registerProviderGroupIpc(options: { reshare?: ProviderGroupIpcReshare } = {}): void {
  const reshare = options.reshare;
  const deps: ProviderGroupCommandDeps = {
    router: getProviderGroupRouter(),
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    writeGroup: writeProviderGroup,
    pruneBindings: pruneProviderGroupBindings,
    ownerKey: activeOwnerScopeKey,
    remoteView: (deviceId, providerId) => getProviderGroupRemoteClient().view(deviceId, providerId, { includeGuestSupport: true }),
    localDeviceId: getSelfDeviceId,
    listGroups: listProviderGroups,
    sessionGroup: readProviderGroupOfSession,
    changed: (providerId) => {
      // 组里的电脑变了：重新报转分享(加进来的分享来的电脑要请它的主人同意，移出的不再列着)。
      reshare?.kick('group');
      try {
        broadcast(PROVIDER_GROUP_IPC.CHANGED, { providerId });
        // 同账号其他电脑的模型列表按本机目录里的组摘要收起组内电脑：组变化后让它们重读目录。
        tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
      } catch (error) {
        log.warn('provider group broadcast failed', { error: String(error) });
      }
    },
    ...(reshare ? { reshare } : {}),
  };

  ipcMain.handle(PROVIDER_GROUP_IPC.COMMAND, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Provider groups are local only');
    assertTrustedAppRendererEvent(event);
    return executeProviderGroupCommand(deps, parseProviderGroupCommand(raw));
  });
}

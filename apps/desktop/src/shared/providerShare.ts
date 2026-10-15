/**
 * 供应商分享的 Renderer ↔ Main 契约(只在本机进程之间；服务端契约见
 * docs/provider-sharing-contract.md)。身份只有昵称与头像。
 */
import type {
  ProviderShareLinkPreview,
  ProviderShareMember,
  ProviderShareReceived,
  ProviderShareRequestItem,
  ProviderShareRequestState,
} from '@cindy/device-link';
import type { DataOwnerPushStamp } from './dataOwnerPush';

/** 本机收藏清理依据。未加载、断线和账号切换的空列表不能用于撤权清理。 */
export interface ProviderShareReceivedSnapshot {
  ownerStamp: DataOwnerPushStamp;
  /** 仅这些区域的名单完整，可据此清理已撤权收藏；其它区域不受影响。 */
  confirmedRegions: readonly ProviderShareReceived['owner']['region'][];
  received: readonly ProviderShareReceived[];
}

/** 本机收藏作为重启后的查询线索，不作为授权或撤权依据。 */
export interface ProviderShareFavoriteRecovery {
  ownerStamp: DataOwnerPushStamp;
  regions: readonly ProviderShareReceived['owner']['region'][];
}

export const PROVIDER_SHARE_IPC = {
  /** Renderer → Main：全部操作走同一个命令通道。 */
  COMMAND: 'provider-share:command',
  /** 分享者：分享快照变化(管理页按当前时间段重新读取)。 */
  OWNED_CHANGED: 'provider-share:owned-changed',
  /** 受邀者：已收到的分享变化(模型列表)。payload: ProviderShareReceived[] */
  RECEIVED_CHANGED: 'provider-share:received-changed',
  /** 分享者：新的待审批申请。payload: ProviderShareRequestedEvent */
  REQUESTED: 'provider-share:requested',
  /** 受邀者：发出的申请有了结果。payload: ProviderShareSettledEvent */
  SETTLED: 'provider-share:settled',
  /** 打开分享链接(深链或系统通知点击)。payload: { link: string } */
  OPEN_JOIN: 'provider-share:open-join',
  /** 打开某个供应商的分享管理页(系统通知点击)。payload: { providerId: string } */
  OPEN_MANAGE: 'provider-share:open-manage',
} as const;

export type ProviderShareUsageRange = '7d' | 'month' | 'all';

export interface ProviderShareMoney {
  amount: number;
  currency: 'USD' | 'CNY';
}

export interface ProviderShareModelUsageView {
  kind: string;
  providerId: string | null;
  /**
   * 这一部分在哪台组内电脑运行(供应商组的组内电脑稳定键，本机为 `local`)；「用量」块据此按组内电脑展开。
   * 这一字段加上之前记的用量没有区分，为 null。
   */
  memberKey: string | null;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 按本地单价估算；拿不到单价时为 null。 */
  amount: ProviderShareMoney | null;
}

export interface ProviderShareMemberView extends ProviderShareMember {
  lastUsedAt: number | null;
  runningTasks: number;
  models: ProviderShareModelUsageView[];
}

export interface ProviderShareOwnedView {
  shareId: string;
  providerId: string;
  providerLabel: string;
  createdAt: string;
  members: ProviderShareMemberView[];
  requests: ProviderShareRequestItem[];
}

/** 「远程与分享」页按使用方的用量里一个使用方(本机、同账号的另一台电脑，或经那台转来的受邀者任务)。 */
export interface ProviderPartyUsageView {
  /** null = 本机。 */
  deviceId: string | null;
  /** 那台电脑的名字；读不到或本机时为 null。 */
  deviceName: string | null;
  lastUsedAt: number;
  models: ProviderShareModelUsageView[];
}

/**
 * 某个供应商按使用方的用量里，这台电脑自己能记到的部分(provider-groups.md §7)：本机自己的任务(含归本机
 * 供应商组、在组里其他电脑上运行的)，与同账号其他电脑经这台电脑的任务。分享的人在 owned 的成员里。
 * 界面把本机与我的其他电脑合成「自己」一行(当前登录的账号)。
 */
export interface ProviderOwnUsageView {
  providerId: string;
  /** 本机自己的任务；没用过时为 null。 */
  local: ProviderPartyUsageView | null;
  /** 同账号的其他电脑自己的任务，每台一项，最近用过的在前。 */
  devices: ProviderPartyUsageView[];
  /** 同账号的组所在电脑替它的受邀者转到本机运行的任务，每台组所在电脑一项(本机看不到最终使用者)。 */
  relays: ProviderPartyUsageView[];
}

export interface ProviderShareOwnerState {
  /** 分享服务可用(已登录、设备互联已连上本区域服务)。 */
  ready: boolean;
  shares: ProviderShareOwnedView[];
}

export interface ProviderShareLinkCreated {
  link: string;
  expiresAt: string;
}

export interface ProviderShareRequestedEvent {
  request: ProviderShareRequestItem;
  share: { shareId: string; providerId: string; providerLabel: string };
}

export interface ProviderShareSettledEvent {
  state: ProviderShareRequestState;
  preview: ProviderShareLinkPreview | null;
}

export type ProviderShareCommand =
  | { action: 'owned'; range: ProviderShareUsageRange }
  /** 这个供应商按使用方的用量(本机与我的其他电脑)。不依赖分享服务。 */
  | { action: 'own-usage'; providerId: string; range: ProviderShareUsageRange }
  | { action: 'create-link'; providerId: string }
  | { action: 'approve' | 'reject'; requestId: string }
  | { action: 'set-member'; memberId: string; status: 'pause' | 'resume' | 'remove' }
  | { action: 'received' }
  | { action: 'received-snapshot'; favoriteRecovery?: ProviderShareFavoriteRecovery }
  | { action: 'preview'; link: string }
  | { action: 'send-request'; link: string }
  | { action: 'get-request'; requestId: string }
  | { action: 'withdraw'; requestId: string }
  | { action: 'leave'; memberId: string }
  /** 受邀者：这个分享的任务里凭证类操作是否不再在本机确认(provider-sharing.md §9 第 7 条)。 */
  | { action: 'get-credential-consent'; shareId: string }
  | { action: 'set-credential-consent'; shareId: string; skip: boolean };

/** 受邀者对一个分享的本机偏好：true = 凭证类操作不再确认。只对这台电脑生效。 */
export interface ProviderShareCredentialConsentView {
  skip: boolean;
}

export interface ProviderShareCommandResult {
  owned: ProviderShareOwnerState;
  'own-usage': ProviderOwnUsageView;
  'create-link': ProviderShareLinkCreated;
  approve: { ok: true };
  reject: { ok: true };
  'set-member': { ok: true };
  received: ProviderShareReceived[];
  'received-snapshot': ProviderShareReceivedSnapshot;
  preview: ProviderShareLinkPreview;
  'send-request': ProviderShareRequestState;
  'get-request': ProviderShareRequestState;
  withdraw: { ok: true };
  leave: { ok: true };
  'get-credential-consent': ProviderShareCredentialConsentView;
  'set-credential-consent': ProviderShareCredentialConsentView;
}

/** 任务记录里「Agent 在某个分享者的电脑上」的前缀(见 main/device-link/providerShareGuest)。 */
export const PROVIDER_SHARE_AGENT_DEVICE_PREFIX = 'share:';

export function isProviderShareAgentDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX);
}

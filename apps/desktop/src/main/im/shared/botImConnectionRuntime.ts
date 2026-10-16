/**
 * main/im/shared/botImConnectionRuntime.ts
 * ---------------------------------------------------------------------------
 * 伙伴自有 IM 机器人连接的运行时: 每条记录一份传输层实例 + 一个编排器实例。
 *
 *   - 账号 IM 连接启动时(initializeImConnection)按记录逐条起实例并 init;
 *     停止时逐条 dispose 并注销编排器, 记录保留, 下次登录再起。
 *   - 伙伴页「添加平台」: 建记录 → 起实例 → 把凭证交给传输层建连; 连不上就整条撤销,
 *     不留半配置的记录。
 *   - 「移除」/ 伙伴被删: 归档这条连接的隐藏专线、释放运行时、清凭证、删记录。
 *
 * 传输层与编排器的具体装配由 im/index.ts 注入(configureBotImConnectionRuntime),
 * 这里不 import host.ts, 避免把 IM 子系统拽进单测收集期。
 */

import { BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import type { FeishuIM, IMStatus, TelegramIM } from '@cindy/im';

import { createLogger } from '../../logger';
import { getDbClient } from '../../localDb/client/current';
import { archiveBotChannelLanes } from '../../localDb/ipc/bots';
import { botProfiles } from '../../localDb/schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { ownerScopedImSecrets } from '../ownerScopedStorage';
import {
  BOT_IM_CONNECTION_CHANGED_EVENT,
  type BotImConnectionAddInput,
  type BotImConnectionAddResult,
  type BotImConnectionGroupsPayload,
  type BotImConnectionListPayload,
  type BotImConnectionRecord,
  type BotImConnectionRemoveResult,
  type BotImConnectionView,
  type BotImFeishuService,
} from '../../../shared/botImConnection';
import {
  addBotImConnectionRecord,
  isBotImChannel,
  isBotImConnectionId,
  listBotImConnections,
  listBotImConnectionsForBot,
  readBotImConnection,
  removeBotImConnectionRecord,
  secretKeyPrefixFor,
  setBotImConnectionGroupActivation,
  updateBotImConnectionRecord,
} from './botImConnectionStore';
import { companionConnectionRouteKeyPrefix } from './imBotBindingRoute';
import type { ImOrchestrator } from './orchestrator';

const log = createLogger('im:bot-connections');

export type BotImTransportInstance =
  | { kind: 'telegram'; im: TelegramIM; orchestrator: ImOrchestrator }
  | { kind: 'feishu'; im: FeishuIM; orchestrator: ImOrchestrator };

export interface BotImConnectionRuntimeDeps {
  /** 为一条记录装配传输层 + 编排器(不 init)。渠道尚未支持时抛错。 */
  create(record: BotImConnectionRecord): BotImTransportInstance;
  /** 设置页那份个人 bot 当前用的平台身份(用于拒绝同一个 bot 两处同时用)。 */
  settingsIdentity(): { telegramToken: string | null; feishuAppId: string | null };
  /** 这个机器人进过的群(群窗口表里出现过的 chat); 没有群参与模式的渠道返回空。 */
  listKnownGroups(record: BotImConnectionRecord): Promise<Array<{ chatId: string; chatName: string | null }>>;
}

interface LiveInstance {
  record: BotImConnectionRecord;
  transport: BotImTransportInstance;
  offStatus: () => void;
}

/** 传输层按前缀写进安全存储的全部键名(移除连接时一并清掉)。 */
const TELEGRAM_SECRET_KEYS = [
  'telegram-bot-token',
  'telegram-owner-user-id',
  'telegram-bot-runtime-active',
  'telegram-updates-offset',
  'telegram-bot-offline',
] as const;
const FEISHU_SECRET_KEYS = [
  'feishu_bot_app_id',
  'feishu_bot_app_secret',
  'feishu_bot_service',
  'feishu_bot_owner_open_id',
  'feishu_bot_lifecycle_announcement',
] as const;

let deps: BotImConnectionRuntimeDeps | null = null;
const instances = new Map<string, LiveInstance>();
let ipcRegistered = false;

export function configureBotImConnectionRuntime(next: BotImConnectionRuntimeDeps): void {
  deps = next;
}

function requireDeps(): BotImConnectionRuntimeDeps {
  if (!deps) throw new Error('bot im connection runtime is not configured');
  return deps;
}

function purgeSecrets(record: Pick<BotImConnectionRecord, 'id' | 'channel'>): void {
  const prefix = secretKeyPrefixFor(record.id);
  const keys = record.channel === 'telegram' ? TELEGRAM_SECRET_KEYS : FEISHU_SECRET_KEYS;
  for (const key of keys) ownerScopedImSecrets.remove(`${prefix}${key}`);
}

function statusOf(transport: BotImTransportInstance | undefined): IMStatus {
  return transport?.im.getStatus() ?? { kind: 'idle' };
}

function toView(record: BotImConnectionRecord): BotImConnectionView {
  const live = instances.get(record.id);
  const transport = live?.transport;
  const telegramState = transport?.kind === 'telegram' ? transport.im.getConfigState() : null;
  return {
    ...record,
    status: statusOf(transport),
    identity: {
      username: telegramState?.botUsername ?? null,
      ownerUserId: telegramState?.ownerUserId ?? null,
    },
  };
}

export function buildBotImConnectionListPayload(): BotImConnectionListPayload {
  return { connections: listBotImConnections().map(toView) };
}

function broadcastChanged(): void {
  const payload = buildBotImConnectionListPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(BOT_IM_CONNECTION_CHANGED_EVENT, payload);
    } catch {
      // Best-effort UI refresh only.
    }
  }
}

function instantiate(record: BotImConnectionRecord): LiveInstance {
  const transport = requireDeps().create(record);
  const offStatus = transport.im.onStatusChange((status) => {
    // 连上后记下平台身份: 专线 route key 与移除时的归档范围都按它。
    if (status.kind === 'connected' && status.appId && record.botContextId !== status.appId) {
      void updateBotImConnectionRecord(record.id, { botContextId: status.appId })
        .then((next) => {
          if (next) live.record = next;
        })
        .catch((err) => {
          log.warn(`bot im connection ${record.id}: persist botContextId failed: ${String(err)}`);
        });
    }
    broadcastChanged();
  });
  const live: LiveInstance = { record, transport, offStatus };
  instances.set(record.id, live);
  return live;
}

async function releaseInstance(live: LiveInstance): Promise<void> {
  live.offStatus();
  try {
    await live.transport.im.dispose();
  } catch (err) {
    log.warn(`bot im connection ${live.record.id}: dispose failed: ${String(err)}`);
  }
  live.transport.orchestrator.unregister();
  instances.delete(live.record.id);
}

/** 账号 IM 连接启动: 按记录起全部伙伴连接(各自失败只记日志, 不挡其它)。 */
export async function startBotImConnections(): Promise<void> {
  if (!deps) return;
  for (const record of listBotImConnections()) {
    if (instances.has(record.id)) continue;
    try {
      const live = instantiate(record);
      await live.transport.im.init();
    } catch (err) {
      log.error(`bot im connection ${record.id} (${record.channel}) start failed: ${String(err)}`);
    }
  }
}

/** 账号 IM 连接停止: 释放全部实例, 记录保留。 */
export async function stopBotImConnections(): Promise<void> {
  for (const live of [...instances.values()]) await releaseInstance(live);
}

export function getBotImConnectionOrchestrator(id: string): ImOrchestrator | undefined {
  return instances.get(id)?.transport.orchestrator;
}

async function readBotProfileStatus(botId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ status: botProfiles.status })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  return row?.status ?? null;
}

function assertNoDuplicateIdentity(input: BotImConnectionAddInput): void {
  const settings = requireDeps().settingsIdentity();
  if (input.channel === 'telegram') {
    const sameAsSettings = settings.telegramToken !== null && settings.telegramToken === input.token;
    const sameAsOther = listBotImConnections().some(
      (record) =>
        record.channel === 'telegram' &&
        ownerScopedImSecrets.read(`${secretKeyPrefixFor(record.id)}telegram-bot-token`) === input.token,
    );
    if (sameAsSettings || sameAsOther) {
      throwIpcError('PRECONDITION_FAILED', 'TOKEN_IN_USE: this Telegram bot is already connected on this computer');
    }
    return;
  }
  const sameAsSettings = settings.feishuAppId !== null && settings.feishuAppId === input.appId;
  const sameAsOther = listBotImConnections().some(
    (record) =>
      record.channel === 'feishu' &&
      ownerScopedImSecrets.read(`${secretKeyPrefixFor(record.id)}feishu_bot_app_id`) === input.appId,
  );
  if (sameAsSettings || sameAsOther) {
    throwIpcError('PRECONDITION_FAILED', 'APP_IN_USE: this Feishu app is already connected on this computer');
  }
}

function describeStatusFailure(status: IMStatus): string {
  if (status.kind === 'error') return status.code ? `${status.code}: ${status.reason}` : status.reason;
  if (status.kind === 'conflict') return 'conflict';
  return status.kind;
}

export async function addBotImConnection(input: BotImConnectionAddInput): Promise<BotImConnectionAddResult> {
  const status = await readBotProfileStatus(input.botId);
  if (status === null) throwIpcError('NOT_FOUND', 'BOT_NOT_FOUND');
  if (status !== 'active') throwIpcError('PRECONDITION_FAILED', `BOT_INACTIVE: ${status}`);
  assertNoDuplicateIdentity(input);

  const record = await addBotImConnectionRecord({
    botId: input.botId,
    channel: input.channel,
    ...(input.channel === 'feishu' ? { service: input.service } : {}),
  });
  let live: LiveInstance;
  try {
    live = instantiate(record);
  } catch (err) {
    await removeBotImConnectionRecord(record.id);
    throw err;
  }

  const rollback = async (reason: string): Promise<never> => {
    await releaseInstance(live);
    purgeSecrets(record);
    await removeBotImConnectionRecord(record.id);
    broadcastChanged();
    return throwIpcError('PRECONDITION_FAILED', `CONNECT_FAILED: ${reason}`);
  };

  if (live.transport.kind === 'telegram') {
    if (input.channel !== 'telegram') return rollback('channel mismatch');
    let state: Awaited<ReturnType<TelegramIM['setConfig']>>;
    try {
      state = await live.transport.im.setConfig({ token: input.token, ownerUserId: input.ownerUserId });
    } catch (err) {
      return rollback(err instanceof Error ? err.message : String(err));
    }
    const failed = state.saveErrorStatus ?? (state.status.kind === 'connected' ? null : state.status);
    if (failed) return rollback(describeStatusFailure(failed));
  } else {
    if (input.channel !== 'feishu') return rollback('channel mismatch');
    let verdict: string;
    try {
      verdict = (
        await live.transport.im.saveCredentials({
          appId: input.appId,
          appSecret: input.appSecret,
          service: input.service as BotImFeishuService,
        })
      ).verdict;
    } catch (err) {
      return rollback(err instanceof Error ? err.message : String(err));
    }
    if (verdict !== 'connected' && verdict !== 'pending') return rollback(verdict);
  }

  const connected = live.transport.im.getStatus();
  if (connected.kind === 'connected' && connected.appId) {
    const next = await updateBotImConnectionRecord(record.id, { botContextId: connected.appId });
    if (next) live.record = next;
  }
  log.info(
    `bot im connection ${record.id} (${record.channel}) added for bot=...${record.botId.slice(-8)} status=${connected.kind}`,
  );
  broadcastChanged();
  const list = buildBotImConnectionListPayload();
  const view = list.connections.find((item) => item.id === record.id) ?? toView(live.record);
  return { ...list, connection: view };
}

/** 伙伴页「群聊」小节: 已知群 + 每群参与模式(仅 @ / 全响应)。 */
export async function listBotImConnectionGroups(id: string): Promise<BotImConnectionGroupsPayload> {
  const record = readBotImConnection(id);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const groups = record.botContextId ? await requireDeps().listKnownGroups(record) : [];
  const activation = record.groupActivation ?? {};
  return {
    connectionId: id,
    groups: groups.map((group) => ({
      chatId: group.chatId,
      chatName: group.chatName,
      activation: activation[group.chatId] === 'always' ? 'always' : 'mention',
    })),
  };
}

export async function setBotImConnectionGroupMode(
  id: string,
  chatId: string,
  mode: 'mention' | 'always',
): Promise<BotImConnectionGroupsPayload> {
  const updated = await setBotImConnectionGroupActivation(id, chatId, mode);
  if (!updated) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const live = instances.get(id);
  if (live) live.record = updated;
  log.info(`bot im connection ${id}: group ${chatId.slice(-6)} activation=${mode}`);
  return listBotImConnectionGroups(id);
}

export async function removeBotImConnection(id: string): Promise<BotImConnectionRemoveResult> {
  const record = readBotImConnection(id);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const live = instances.get(id);
  // 先归档这条连接的全部隐藏专线, 再放掉它们的运行时。
  let archivedSessionIds: string[] = [];
  if (record.botContextId) {
    try {
      archivedSessionIds = await archiveBotChannelLanes({
        routeKeyPrefix: companionConnectionRouteKeyPrefix(record.channel, record.botContextId),
      });
    } catch (err) {
      log.warn(`bot im connection ${id}: archive lanes failed: ${String(err)}`);
    }
  }
  if (live) {
    for (const sessionId of archivedSessionIds) {
      try {
        await live.transport.orchestrator.turnRunner.disposeOneSession(sessionId);
      } catch (err) {
        log.warn(`bot im connection ${id}: dispose lane ${sessionId} failed: ${String(err)}`);
      }
    }
    try {
      await live.transport.orchestrator.disposeAllSessions();
    } catch (err) {
      log.warn(`bot im connection ${id}: disposeAllSessions failed: ${String(err)}`);
    }
    try {
      // 解绑: 清命令菜单、通知主人、删凭证(传输层自己的那份)。
      if (live.transport.kind === 'telegram') await live.transport.im.disconnect();
      else await live.transport.im.clearCredentials();
    } catch (err) {
      log.warn(`bot im connection ${id}: disconnect failed: ${String(err)}`);
    }
    await releaseInstance(live);
  }
  purgeSecrets(record);
  await removeBotImConnectionRecord(id);
  log.info(`bot im connection ${id} (${record.channel}) removed archivedLanes=${archivedSessionIds.length}`);
  broadcastChanged();
  return { ...buildBotImConnectionListPayload(), archivedSessionIds };
}

/** 伙伴被删除 / 归档时带走它的全部连接。 */
export async function removeBotImConnectionsForBot(botId: string): Promise<void> {
  for (const record of listBotImConnectionsForBot(botId)) {
    try {
      await removeBotImConnection(record.id);
    } catch (err) {
      log.warn(`remove bot im connection ${record.id} for bot=...${botId.slice(-8)} failed: ${String(err)}`);
    }
  }
}

function readAddInput(payload: unknown): BotImConnectionAddInput {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (typeof p.botId !== 'string' || !p.botId.trim()) throwIpcError('INVALID_PARAMS', 'botId is required');
  if (!isBotImChannel(p.channel)) throwIpcError('INVALID_PARAMS', 'channel is invalid');
  const botId = p.botId.trim();
  if (p.channel === 'telegram') {
    const token = typeof p.token === 'string' ? p.token.trim() : '';
    const ownerUserId = typeof p.ownerUserId === 'string' ? p.ownerUserId.trim() : '';
    if (!/^\d{6,20}:[A-Za-z0-9_-]{20,}$/.test(token)) throwIpcError('INVALID_PARAMS', 'token is invalid');
    if (!/^\d{1,20}$/.test(ownerUserId)) throwIpcError('INVALID_PARAMS', 'ownerUserId is invalid');
    return { botId, channel: 'telegram', token, ownerUserId };
  }
  const appId = typeof p.appId === 'string' ? p.appId.trim() : '';
  const appSecret = typeof p.appSecret === 'string' ? p.appSecret.trim() : '';
  const service: BotImFeishuService = p.service === 'lark' ? 'lark' : 'feishu';
  if (!appId || appId.length > 128) throwIpcError('INVALID_PARAMS', 'appId is invalid');
  if (!appSecret || appSecret.length > 512) throwIpcError('INVALID_PARAMS', 'appSecret is invalid');
  return { botId, channel: 'feishu', appId, appSecret, service };
}

export function registerBotImConnectionIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('botImConnection:list', (e) => {
    assertTrustedAppRendererEvent(e);
    return buildBotImConnectionListPayload();
  });
  ipcMain.handle('botImConnection:add', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    return addBotImConnection(readAddInput(payload));
  });
  ipcMain.handle('botImConnection:remove', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isBotImConnectionId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    return removeBotImConnection(id);
  });
  ipcMain.handle('botImConnection:list-groups', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isBotImConnectionId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    return listBotImConnectionGroups(id);
  });
  ipcMain.handle('botImConnection:set-group-activation', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { id?: unknown; chatId?: unknown; mode?: unknown };
    if (!isBotImConnectionId(p.id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    if (typeof p.chatId !== 'string' || !/^-?\d{1,32}$/.test(p.chatId)) {
      throwIpcError('INVALID_PARAMS', 'chatId is invalid');
    }
    const mode = p.mode === 'always' ? 'always' : 'mention';
    return setBotImConnectionGroupMode(p.id, p.chatId, mode);
  });
}

export const __testing = { instances, purgeSecrets, toView };

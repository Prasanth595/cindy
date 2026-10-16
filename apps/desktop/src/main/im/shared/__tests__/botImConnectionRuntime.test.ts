/**
 * 伙伴自有 IM 连接运行时: 添加 → 起实例 → 交凭证建连; 连不上整条撤销(记录 + 凭证);
 * 移除 → 归档专线、解绑、清凭证、注销编排器; 停止只放实例不删记录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotImConnectionRecord } from '../../../../shared/botImConnection';

const h = vi.hoisted(() => ({
  root: '',
  secrets: new Map<string, string>(),
  botStatus: 'active' as string | null,
  archived: [] as string[],
  archiveCalls: [] as unknown[],
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.root },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } },
    ],
  },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner-a' }));
// 记录存储(.js 说明符)与凭证存储(无后缀说明符)解析到同一个模块: 一份 mock 同时提供两者。
vi.mock('../../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', 'owner-a', ...parts),
  ownerScopedImSecrets: {
    isAvailable: () => true,
    read: (name: string) => h.secrets.get(name) ?? null,
    readResult: (name: string) =>
      h.secrets.has(name) ? { kind: 'value', value: h.secrets.get(name) } : { kind: 'missing' },
    write: (name: string, value: string) => {
      h.secrets.set(name, value);
      return true;
    },
    remove: (name: string) => {
      h.secrets.delete(name);
    },
  },
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.botStatus === null ? [] : [{ status: h.botStatus }]) }),
        }),
      }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({ botProfiles: { id: 'id', status: 'status' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../../localDb/ipc/bots', () => ({
  archiveBotChannelLanes: vi.fn(async (input: unknown) => {
    h.archiveCalls.push(input);
    return h.archived;
  }),
}));
vi.mock('../../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: vi.fn() }));

import {
  addBotImConnection,
  configureBotImConnectionRuntime,
  listBotImConnectionGroups,
  removeBotImConnection,
  setBotImConnectionGroupMode,
  removeBotImConnectionsForBot,
  startBotImConnections,
  stopBotImConnections,
  __testing,
} from '../botImConnectionRuntime';
import { listBotImConnections, secretKeyPrefixFor } from '../botImConnectionStore';

type StatusHandler = (status: { kind: string; appId?: string }) => void;

function fakeTelegram(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: { kind: string; appId?: string; reason?: string } = { kind: 'idle' };
  const set = (next: typeof status) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  const im = {
    init: vi.fn(async () => {
      if (h.secrets.has(`${prefix}telegram-bot-token`)) set({ kind: 'connected', appId: '777' });
    }),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getConfigState: () => ({ status, ownerUserId: h.secrets.get(`${prefix}telegram-owner-user-id`) ?? null, botUsername: 'mia_bot' }),
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => {
      h.secrets.set(`${prefix}telegram-bot-token`, payload.token);
      h.secrets.set(`${prefix}telegram-owner-user-id`, payload.ownerUserId);
      if (!opts.connect) {
        h.secrets.delete(`${prefix}telegram-bot-token`);
        h.secrets.delete(`${prefix}telegram-owner-user-id`);
        set({ kind: 'error', reason: 'Unauthorized', code: 'auth' } as typeof status);
        return { status, ownerUserId: null, botUsername: null, saveErrorStatus: status };
      }
      set({ kind: 'connected', appId: '777' });
      return { status, ownerUserId: payload.ownerUserId, botUsername: 'mia_bot' };
    }),
    disconnect: vi.fn(async () => {
      h.secrets.delete(`${prefix}telegram-bot-token`);
      h.secrets.delete(`${prefix}telegram-owner-user-id`);
      set({ kind: 'idle' });
      return { status };
    }),
  };
  return im;
}

type FakeStatus = { kind: string; appId?: string; reason?: string; code?: string };

/** 企业微信: 凭证同步落盘, 建连异步(下一拍才到终态)。 */
function fakeWecom(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}wecom-owner-user-id`) ?? '',
    setConfig: vi.fn(async (payload: { botId: string; secret: string }) => {
      h.secrets.set(`${prefix}wecom-bot-id`, payload.botId);
      h.secrets.set(`${prefix}wecom-bot-secret`, payload.secret);
      set({ kind: 'connecting' });
      setTimeout(() => {
        if (opts.connect) set({ kind: 'connected', appId: payload.botId });
        else set({ kind: 'error', reason: 'bad secret' });
      }, 0);
      return { status, botId: payload.botId, ownerUserId: null };
    }),
    clearCredentials: vi.fn(async () => {
      h.secrets.delete(`${prefix}wecom-bot-id`);
      h.secrets.delete(`${prefix}wecom-bot-secret`);
      set({ kind: 'idle' });
      return { status, botId: null, ownerUserId: null };
    }),
  };
}

/** 钉钉: 先连通再落盘, 连不上抛错。 */
function fakeDingTalk(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}dingtalk-bot-owner-user-id`) ?? '',
    saveCredentials: vi.fn(async (payload: { appKey: string; appSecret: string }) => {
      if (!opts.connect) {
        set({ kind: 'error', reason: 'stream refused' });
        throw new Error('DINGTALK_CONNECT_FAILED');
      }
      h.secrets.set(`${prefix}dingtalk-bot-app-key`, payload.appKey);
      h.secrets.set(`${prefix}dingtalk-bot-app-secret`, payload.appSecret);
      set({ kind: 'connected', appId: payload.appKey });
      return { status, appKey: payload.appKey, ownerUserId: null };
    }),
    clearCredentials: vi.fn(async () => {
      h.secrets.delete(`${prefix}dingtalk-bot-app-key`);
      h.secrets.delete(`${prefix}dingtalk-bot-app-secret`);
      set({ kind: 'idle' });
    }),
  };
}

/** Discord: status.appId 是展示用的 bot 标签, 路由身份是 botContextId(应用 id)。 */
function fakeDiscord(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    get botContextId() {
      return status.kind === 'connected' ? '9001' : '';
    },
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}discord-owner-user-id`) ?? '',
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => {
      if (!opts.connect) {
        set({ kind: 'error', reason: 'Invalid token', code: 'auth' });
        return { status, ownerUserId: null, saveErrorStatus: status };
      }
      h.secrets.set(`${prefix}discord-bot-token`, payload.token);
      h.secrets.set(`${prefix}discord-owner-user-id`, payload.ownerUserId);
      set({ kind: 'connected', appId: 'Mia#1234' });
      return { status, ownerUserId: payload.ownerUserId };
    }),
    disconnect: vi.fn(async () => {
      h.secrets.delete(`${prefix}discord-bot-token`);
      h.secrets.delete(`${prefix}discord-owner-user-id`);
      set({ kind: 'idle' });
      return { status };
    }),
  };
}

function fakeOrchestrator() {
  return {
    channel: 'telegram',
    turnRunner: { disposeOneSession: vi.fn(async () => undefined) },
    disposeAllSessions: vi.fn(async () => undefined),
    unregister: vi.fn(),
  };
}

const created: Array<{ record: BotImConnectionRecord; im: ReturnType<typeof fakeTelegram>; orchestrator: ReturnType<typeof fakeOrchestrator> }> = [];
const createdOther: Array<{
  record: BotImConnectionRecord;
  im: ReturnType<typeof fakeWecom> | ReturnType<typeof fakeDingTalk> | ReturnType<typeof fakeDiscord>;
  orchestrator: ReturnType<typeof fakeOrchestrator>;
}> = [];
let connectOutcome = true;

describe('bot im connection runtime', () => {
  beforeEach(() => {
    h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-im-runtime-'));
    h.secrets.clear();
    h.botStatus = 'active';
    h.archived = [];
    h.archiveCalls = [];
    h.sent = [];
    created.length = 0;
    createdOther.length = 0;
    connectOutcome = true;
    configureBotImConnectionRuntime({
      create: (record) => {
        const prefix = secretKeyPrefixFor(record.id);
        const orchestrator = fakeOrchestrator();
        if (record.channel === 'telegram') {
          const im = fakeTelegram(prefix, { connect: connectOutcome });
          created.push({ record, im, orchestrator });
          return { kind: 'telegram', im: im as never, orchestrator: orchestrator as never };
        }
        const im =
          record.channel === 'wecom'
            ? fakeWecom(prefix, { connect: connectOutcome })
            : record.channel === 'dingtalk'
              ? fakeDingTalk(prefix, { connect: connectOutcome })
              : fakeDiscord(prefix, { connect: connectOutcome });
        createdOther.push({ record, im, orchestrator });
        return { kind: record.channel, im: im as never, orchestrator: orchestrator as never } as never;
      },
      settingsIdentity: () => ({
        telegramToken: h.secrets.get('telegram-bot-token') ?? null,
        feishuAppId: null,
        wecomBotId: h.secrets.get('wecom-bot-id') ?? null,
        dingtalkAppKey: h.secrets.get('dingtalk-bot-app-key') ?? null,
        discordToken: h.secrets.get('discord-bot-token') ?? null,
      }),
      listKnownGroups: async () => [{ chatId: '-1001', chatName: 'Dev Group' }],
    });
  });

  it('lists known groups with their per-connection activation and toggles it live', async () => {
    const added = await addBotImConnection({
      botId: 'bot-mia',
      channel: 'telegram',
      token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
      ownerUserId: '42',
    });
    const id = added.connection.id;
    expect((await listBotImConnectionGroups(id)).groups).toEqual([
      { chatId: '-1001', chatName: 'Dev Group', activation: 'mention' },
    ]);
    const on = await setBotImConnectionGroupMode(id, '-1001', 'always');
    expect(on.groups[0]?.activation).toBe('always');
    // 传输层的行为 getter 读的是记录正本: 这里立刻能看到, 不需要重启实例。
    expect(listBotImConnections()[0]?.groupActivation).toEqual({ '-1001': 'always' });
    expect(__testing.instances.get(id)?.record.groupActivation).toEqual({ '-1001': 'always' });
    const off = await setBotImConnectionGroupMode(id, '-1001', 'mention');
    expect(off.groups[0]?.activation).toBe('mention');
    expect(listBotImConnections()[0]?.groupActivation).toBeUndefined();
  });

  afterEach(async () => {
    await stopBotImConnections();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('adds a Telegram connection, hands the credentials to its own transport and records the platform id', async () => {
    const result = await addBotImConnection({
      botId: 'bot-mia',
      channel: 'telegram',
      token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      ownerUserId: '4242',
    });
    expect(created).toHaveLength(1);
    const prefix = secretKeyPrefixFor(result.connection.id);
    expect(created[0]!.im.setConfig).toHaveBeenCalledWith({ token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    expect(h.secrets.get(`${prefix}telegram-bot-token`)).toBe('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(h.secrets.has('telegram-bot-token')).toBe(false);
    expect(result.connection).toMatchObject({
      botId: 'bot-mia',
      channel: 'telegram',
      botContextId: '777',
      status: { kind: 'connected', appId: '777' },
      identity: { username: 'mia_bot', ownerUserId: '4242' },
    });
    expect(listBotImConnections()[0]?.botContextId).toBe('777');
    expect(h.sent.some((item) => item.channel === 'botImConnection:changed')).toBe(true);
    expect(__testing.instances.size).toBe(1);
  });

  it('rolls the whole connection back when the transport cannot connect', async () => {
    connectOutcome = false;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/CONNECT_FAILED: auth: Unauthorized/);
    expect(listBotImConnections()).toEqual([]);
    expect([...h.secrets.keys()]).toEqual([]);
    expect(created[0]!.im.dispose).toHaveBeenCalled();
    expect(created[0]!.orchestrator.unregister).toHaveBeenCalled();
    expect(__testing.instances.size).toBe(0);
  });

  it('refuses an inactive teammate and a token already used by the settings-page bot', async () => {
    h.botStatus = 'paused';
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/BOT_INACTIVE/);
    h.botStatus = null;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/BOT_NOT_FOUND/);
    h.botStatus = 'active';
    h.secrets.set('telegram-bot-token', '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/TOKEN_IN_USE/);
    expect(created).toHaveLength(0);
    expect(listBotImConnections()).toEqual([]);
  });

  it('removes a connection: archives its lanes, disconnects, purges credentials and unregisters', async () => {
    const added = await addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    h.archived = ['lane-1', 'lane-2'];
    const removed = await removeBotImConnection(added.connection.id);
    expect(h.archiveCalls).toEqual([{ routeKeyPrefix: 'im:telegram:777:' }]);
    expect(removed.archivedSessionIds).toEqual(['lane-1', 'lane-2']);
    const inst = created[0]!;
    expect(inst.orchestrator.turnRunner.disposeOneSession).toHaveBeenCalledTimes(2);
    expect(inst.im.disconnect).toHaveBeenCalled();
    expect(inst.im.dispose).toHaveBeenCalled();
    expect(inst.orchestrator.unregister).toHaveBeenCalled();
    expect([...h.secrets.keys()]).toEqual([]);
    expect(listBotImConnections()).toEqual([]);
    expect(removed.connections).toEqual([]);
  });

  it('starts recorded connections on login, keeps records across stop, and drops them with the teammate', async () => {
    const a = await addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    await stopBotImConnections();
    expect(__testing.instances.size).toBe(0);
    expect(listBotImConnections().map((r) => r.id)).toEqual([a.connection.id]);
    expect(h.secrets.has(`${secretKeyPrefixFor(a.connection.id)}telegram-bot-token`)).toBe(true);

    await startBotImConnections();
    expect(__testing.instances.size).toBe(1);
    expect(created.at(-1)!.im.init).toHaveBeenCalled();
    expect(__testing.toView(listBotImConnections()[0]!).status).toEqual({ kind: 'connected', appId: '777' });

    await removeBotImConnectionsForBot('bot-mia');
    expect(listBotImConnections()).toEqual([]);
    expect(__testing.instances.size).toBe(0);
  });

  it('adds WeCom, DingTalk and Discord connections through their own transports and records each routing identity', async () => {
    const wecom = await addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' });
    const dingtalk = await addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'ding-secret' });
    const discord = await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    expect(createdOther.map((item) => item.record.channel)).toEqual(['wecom', 'dingtalk', 'discord']);
    const [wecomIm, dingIm, discordIm] = createdOther.map((item) => item.im) as [
      ReturnType<typeof fakeWecom>,
      ReturnType<typeof fakeDingTalk>,
      ReturnType<typeof fakeDiscord>,
    ];
    expect(wecomIm.setConfig).toHaveBeenCalledWith({ botId: 'wb-1', secret: 's3cret' });
    expect(dingIm.saveCredentials).toHaveBeenCalledWith({ appKey: 'ding-key', appSecret: 'ding-secret' });
    expect(discordIm.setConfig).toHaveBeenCalledWith({ token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    // 凭证只在各自前缀下, 设置页那份键名不受影响。
    expect(h.secrets.get(`${secretKeyPrefixFor(wecom.connection.id)}wecom-bot-id`)).toBe('wb-1');
    expect(h.secrets.has('wecom-bot-id')).toBe(false);
    expect(h.secrets.has('dingtalk-bot-app-key')).toBe(false);
    expect(h.secrets.has('discord-bot-token')).toBe(false);
    // 异步建连的企业微信等到了终态再记身份; Discord 记应用 id 而不是展示用的 bot 标签。
    expect(wecom.connection).toMatchObject({ channel: 'wecom', botContextId: 'wb-1', status: { kind: 'connected' } });
    expect(dingtalk.connection).toMatchObject({ channel: 'dingtalk', botContextId: 'ding-key', status: { kind: 'connected' } });
    expect(discord.connection).toMatchObject({
      channel: 'discord',
      botContextId: '9001',
      status: { kind: 'connected', appId: 'Mia#1234' },
      identity: { username: 'Mia#1234', ownerUserId: '123456789012345678' },
    });
    expect(listBotImConnections().map((r) => r.botContextId)).toEqual(['wb-1', 'ding-key', '9001']);
  });

  it('rolls back WeCom / DingTalk / Discord connections that fail to connect, leaving no record or key', async () => {
    connectOutcome = false;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' }),
    ).rejects.toThrow(/CONNECT_FAILED: bad secret/);
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'ding-secret' }),
    ).rejects.toThrow(/CONNECT_FAILED: DINGTALK_CONNECT_FAILED/);
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' }),
    ).rejects.toThrow(/CONNECT_FAILED: auth: Invalid token/);
    expect(listBotImConnections()).toEqual([]);
    expect([...h.secrets.keys()]).toEqual([]);
    expect(createdOther).toHaveLength(3);
    for (const item of createdOther) {
      expect(item.im.dispose).toHaveBeenCalled();
      expect(item.orchestrator.unregister).toHaveBeenCalled();
    }
    expect(__testing.instances.size).toBe(0);
  });

  it('refuses a WeCom bot, DingTalk app or Discord token already used by the settings-page bot or another teammate', async () => {
    h.secrets.set('wecom-bot-id', 'wb-1');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' }),
    ).rejects.toThrow(/APP_IN_USE/);
    h.secrets.set('dingtalk-bot-app-key', 'ding-key');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'x' }),
    ).rejects.toThrow(/APP_IN_USE/);
    await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    await expect(
      addBotImConnection({ botId: 'bot-lizi', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' }),
    ).rejects.toThrow(/TOKEN_IN_USE/);
    expect(listBotImConnections()).toHaveLength(1);
  });

  it('removes Discord via disconnect and WeCom via clearCredentials, purging only their own keys', async () => {
    const wecom = await addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' });
    const discord = await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    h.secrets.set(`${secretKeyPrefixFor(wecom.connection.id)}wecom-owner-user-id`, 'zhangsan');
    await removeBotImConnection(discord.connection.id);
    expect(h.archiveCalls.at(-1)).toEqual({ routeKeyPrefix: 'im:discord:9001:' });
    expect((createdOther[1]!.im as ReturnType<typeof fakeDiscord>).disconnect).toHaveBeenCalled();
    expect([...h.secrets.keys()].some((key) => key.includes('discord'))).toBe(false);
    expect(h.secrets.get(`${secretKeyPrefixFor(wecom.connection.id)}wecom-bot-id`)).toBe('wb-1');
    await removeBotImConnection(wecom.connection.id);
    expect(h.archiveCalls.at(-1)).toEqual({ routeKeyPrefix: 'im:wecom:wb-1:' });
    expect((createdOther[0]!.im as ReturnType<typeof fakeWecom>).clearCredentials).toHaveBeenCalled();
    expect([...h.secrets.keys()]).toEqual([]);
    expect(listBotImConnections()).toEqual([]);
  });
});

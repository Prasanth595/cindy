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
  removeBotImConnection,
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

function fakeOrchestrator() {
  return {
    channel: 'telegram',
    turnRunner: { disposeOneSession: vi.fn(async () => undefined) },
    disposeAllSessions: vi.fn(async () => undefined),
    unregister: vi.fn(),
  };
}

const created: Array<{ record: BotImConnectionRecord; im: ReturnType<typeof fakeTelegram>; orchestrator: ReturnType<typeof fakeOrchestrator> }> = [];
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
    connectOutcome = true;
    configureBotImConnectionRuntime({
      create: (record) => {
        const im = fakeTelegram(secretKeyPrefixFor(record.id), { connect: connectOutcome });
        const orchestrator = fakeOrchestrator();
        created.push({ record, im, orchestrator });
        return { kind: 'telegram', im: im as never, orchestrator: orchestrator as never };
      },
      settingsIdentity: () => ({ telegramToken: h.secrets.get('telegram-bot-token') ?? null, feishuAppId: null }),
    });
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
});

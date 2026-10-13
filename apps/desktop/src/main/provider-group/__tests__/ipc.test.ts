/**
 * 供应商组设置的 IPC 业务体：入参校验，以及「新加入的电脑必须是这台电脑已经能用的同一个供应商」。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../runtime.js', () => ({
  getProviderGroupDirectory: vi.fn(),
  getProviderGroupRouter: vi.fn(),
  getProviderGroupRemoteClient: vi.fn(),
  readProviderGroupOfSession: vi.fn(),
}));
vi.mock('../store.js', () => ({ readProviderGroup: vi.fn(), writeProviderGroup: vi.fn() }));
vi.mock('../bindings.js', () => ({ pruneProviderGroupBindings: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner-a' }));
vi.mock('../../device-link/index.js', () => ({ broadcast: vi.fn(), getSelfDeviceId: vi.fn(() => 'self') }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import type { ProviderGroupCandidate, ProviderGroupConfig } from '../../../shared/providerGroup';
import {
  executeProviderGroupCommand,
  markMembersUnreachableHere,
  parseProviderGroupCommand,
  PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS,
  type ProviderGroupCommandDeps,
} from '../ipc';

const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
const MINI = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device' as const,
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'stale label',
  limit: 4,
  weight: 1,
  paused: false,
};

function deps(candidates: ProviderGroupCandidate[], existing: ProviderGroupConfig | null = null) {
  let stored = existing;
  let owner = 'owner-a';
  return {
    switchOwner: (next: string) => { owner = next; },
    ownerKey: vi.fn(() => owner),
    localDeviceId: vi.fn(() => 'self'),
    pruneBindings: vi.fn(async () => {}),
    router: { view: vi.fn(async (providerId: string) => ({ providerId, config: stored, members: [] })) },
    directory: { listCandidates: vi.fn(async () => candidates), resolveMembers: vi.fn(), invalidate: vi.fn() },
    readGroup: vi.fn(() => stored),
    writeGroup: vi.fn(async (_id: string, config: unknown) => {
      stored = config as ProviderGroupConfig | null;
      return stored;
    }),
    changed: vi.fn(),
  } as unknown as ProviderGroupCommandDeps & {
    writeGroup: ReturnType<typeof vi.fn>;
    changed: ReturnType<typeof vi.fn>;
    pruneBindings: ReturnType<typeof vi.fn>;
    switchOwner(next: string): void;
  };
}

describe('parseProviderGroupCommand', () => {
  it('rejects malformed commands', () => {
    expect(() => parseProviderGroupCommand(null)).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'get', providerId: 'bad id' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'nope', providerId: 'anthropic' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'save', providerId: 'anthropic' })).toThrow();
    expect(parseProviderGroupCommand({ action: 'get', providerId: 'anthropic' })).toEqual({ action: 'get', providerId: 'anthropic' });
  });

  it('accepts listing this computer’s groups and reading a group on another computer', () => {
    expect(parseProviderGroupCommand({ action: 'list' })).toEqual({ action: 'list' });
    expect(parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' }))
      .toEqual({ action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' });
    expect(() => parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'remote-view', providerId: 'anthropic', deviceId: 'bad id' })).toThrow();
  });

  it('accepts asking which group a task is in, without a provider id', () => {
    expect(parseProviderGroupCommand({ action: 'session-group', sessionId: 'db5a0a2c-3084-408c-9f78-234fe3c6745c' }))
      .toEqual({ action: 'session-group', sessionId: 'db5a0a2c-3084-408c-9f78-234fe3c6745c' });
    expect(() => parseProviderGroupCommand({ action: 'session-group' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'session-group', sessionId: '../x' })).toThrow();
  });
});

describe('executeProviderGroupCommand reads', () => {
  it('lists local groups without touching the network and forwards remote views', async () => {
    const d = deps([]);
    const listGroups = vi.fn(() => ({ anthropic: { strategy: 'least', autoSwitch: true, members: [] } }));
    const remoteView = vi.fn(async () => ({ providerId: 'anthropic', config: null, members: [] }));
    Object.assign(d, { listGroups, remoteView });
    expect(await executeProviderGroupCommand(d, { action: 'list' })).toEqual({ anthropic: expect.any(Object) });
    expect(d.router.view).not.toHaveBeenCalled();
    await executeProviderGroupCommand(d, { action: 'remote-view', providerId: 'anthropic', deviceId: 'mini' });
    expect(remoteView).toHaveBeenCalledWith('mini', 'anthropic');
  });

  it('marks a computer in another computer’s group that this computer cannot reach', async () => {
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [
        LOCAL,
        MINI,
        { ...MINI, key: 'device:self:anthropic', agentDeviceId: 'self', providerId: 'anthropic' },
        { ...MINI, key: 'device:vm:anthropic', agentDeviceId: 'vm', providerId: 'anthropic' },
      ],
    };
    const status = (key: string, state: 'available' | 'cooling') => ({
      key, kind: 'device' as const, label: key, state, running: 2, limit: 4, weight: 1, paused: false,
    });
    const view = {
      providerId: 'anthropic',
      config,
      members: [
        { ...status('local', 'available'), kind: 'local' as const },
        status(MINI.key, 'available'),
        status('device:self:anthropic', 'available'),
        status('device:vm:anthropic', 'cooling'),
      ],
    };
    // 这台电脑读不到 mini 的目录(连不上)。
    const readDeviceCatalog = vi.fn(async (_agentDeviceId: string): Promise<never[]> => {
      throw new Error('[DEVICE_LINK_DEVICE_UNRESPONSIVE] target device mini is unresponsive (circuit open)');
    });
    const marked = await markMembersUnreachableHere(view, { readDeviceCatalog }, 'self');
    // 只核对组所在电脑看着能用、由这台直连的「我的其他电脑」：组所在电脑自己、本机这台、冷却中的都不读。
    expect(readDeviceCatalog.mock.calls.map(([id]) => id)).toEqual(['mini']);
    expect(marked.members.map((m) => [m.key, m.unreachableHere === true])).toEqual([
      ['local', false],
      [MINI.key, true],
      ['device:self:anthropic', false],
      ['device:vm:anthropic', false],
    ]);
    // 其余字段照组所在电脑的回包。
    expect(marked.members[1]).toMatchObject({ state: 'available', running: 2 });
  });

  it('leaves another computer’s group as it is when this computer can reach it or cannot tell', async () => {
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const view = {
      providerId: 'anthropic',
      config,
      members: [{ key: MINI.key, kind: 'device' as const, label: 'mini', state: 'available' as const, running: 0, limit: 4, weight: 1, paused: false }],
    };
    const reachable = vi.fn(async () => []);
    expect(await markMembersUnreachableHere(view, { readDeviceCatalog: reachable }, 'self')).toBe(view);
    // 还不知道本机是哪台(没登录)：不判断。
    const unused = vi.fn(async () => []);
    expect(await markMembersUnreachableHere(view, { readDeviceCatalog: unused }, null)).toBe(view);
    expect(unused).not.toHaveBeenCalled();
  });

  it('does not hold the group view on a slow computer, and does not mark it', async () => {
    vi.useFakeTimers();
    try {
      const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
      const view = {
        providerId: 'anthropic',
        config,
        members: [{ key: MINI.key, kind: 'device' as const, label: 'mini', state: 'available' as const, running: 0, limit: 4, weight: 1, paused: false }],
      };
      // 读目录一直没有结果(还没超时、熔断也还没打开)。
      const slow = vi.fn(() => new Promise<never[]>(() => undefined));
      const pending = markMembersUnreachableHere(view, { readDeviceCatalog: slow }, 'self');
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS);
      expect(await pending).toBe(view);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers which group a task is in from the service', async () => {
    const d = deps([]);
    const sessionGroup = vi.fn(async () => ({ groupDeviceId: 'mini', providerId: 'anthropic' }));
    Object.assign(d, { sessionGroup });
    expect(await executeProviderGroupCommand(d, { action: 'session-group', sessionId: 's1' }))
      .toEqual({ groupDeviceId: 'mini', providerId: 'anthropic' });
    expect(sessionGroup).toHaveBeenCalledWith('s1');
  });
});

describe('executeProviderGroupCommand save', () => {
  it('accepts computers this computer can already use and takes their names from the directory', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    });
    const written = d.writeGroup.mock.calls[0][1] as ProviderGroupConfig;
    expect(written.members.map((m) => m.key)).toEqual(['local', MINI.key]);
    expect(written.members[1].label).toBe('Mac mini');
    expect(d.changed).toHaveBeenCalledWith('anthropic');
  });

  it('refuses a computer that is not offered as a candidate', async () => {
    const d = deps([]);
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
  });

  it('does not re-check members that were already in the group (they may be offline)', async () => {
    const existing: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const d = deps([], existing);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { ...existing, strategy: 'round' },
    });
    expect(d.directory.listCandidates).not.toHaveBeenCalled();
    expect((d.writeGroup.mock.calls[0][1] as ProviderGroupConfig).strategy).toBe('round');
  });

  it('deletes the group when the last member is removed', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [] },
    });
    expect(d.writeGroup).toHaveBeenCalledWith('anthropic', null);
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('releases tasks bound to computers that were removed from the group', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL] },
    });
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', new Set(['local']));

    const removed = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(removed, { action: 'delete', providerId: 'anthropic' });
    expect(removed.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('does not write when the account changed while reading the candidates', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    (d.directory.listCandidates as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      d.switchOwner('owner-b');
      return [{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }];
    });
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
    expect(d.pruneBindings).not.toHaveBeenCalled();
  });
});

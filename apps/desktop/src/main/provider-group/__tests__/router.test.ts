/**
 * 组内电脑的运行数(provider-groups.md §5、§10)：分享来的电脑报来本账号在那台实际跑着几个(含不经组直接用的)，
 * 设置页与分配用同一个数，取它与经组计数中较大的。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupBinding } from '../bindings';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import { createProviderGroupDirectory, type ProviderGroupDirectory, type ResolvedProviderGroupMember } from '../directory';
import { createProviderGroupRouter, PROVIDER_GROUP_PICK_QUICK_MS } from '../router';

const MODEL = 'claude-opus-5-5';

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null, limit = 4): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const SHARE_A = member('share:a:anthropic', 'share', 'share:a', 2);
const SHARE_B = member('share:b:anthropic', 'share', 'share:b');

function harness(reported: Record<string, number>, bindings: Record<string, ProviderGroupBinding> = {}, running: string[] = []) {
  const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [SHARE_A, SHARE_B, LOCAL] };
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => ({
        member: m,
        label: m.key,
        state: 'ok',
        view: view(m.providerId),
        ...(reported[m.key] !== undefined ? { reportedRunning: reported[m.key] } : {}),
      }));
    },
    async listCandidates() {
      return [];
    },
    async readDeviceCatalog() {
      return [];
    },
    async probe() {
      return 'ok' as const;
    },
    memberLabel: (m) => m.key,
    invalidate: () => undefined,
  };
  return createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => bindings,
    isTurnRunning: (sessionId) => running.includes(sessionId),
    now: () => 1_000,
    random: () => 0,
  });
}

describe('provider group running count', () => {
  it('shows what a shared computer reports for this account, including tasks that did not go through the group', async () => {
    const router = harness({ [SHARE_A.key]: 2, [SHARE_B.key]: 1 });
    const members = (await router.view('anthropic')).members;
    expect(members.map((m) => [m.key, m.running, m.state])).toEqual([
      [SHARE_A.key, 2, 'full'],
      [SHARE_B.key, 1, 'available'],
      [LOCAL.key, 0, 'available'],
    ]);
  });

  it('keeps counting tasks the group assigned that the report does not include yet', async () => {
    const router = harness(
      { [SHARE_B.key]: 0 },
      { t1: { providerId: 'anthropic', memberKey: SHARE_B.key, at: 1 } },
      ['t1'],
    );
    const shareB = (await router.view('anthropic')).members.find((m) => m.key === SHARE_B.key);
    expect(shareB?.running).toBe(1);
  });

  it('assigns new tasks by the same count the settings page shows', async () => {
    // 两台分享来的电脑经组都没分过任务，但 A 上本账号已经直接跑着 1 个：最少占用选本机或 B，不选 A。
    const router = harness({ [SHARE_A.key]: 1, [SHARE_B.key]: 0 }, {}, []);
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL });
    expect(pick).toMatchObject({ kind: 'member', member: { key: SHARE_B.key } });
  });
});

describe('provider group picks for this computer’s own tasks', () => {
  it('reserves the chosen computer until the task starts, so tasks opened together spread out', async () => {
    const bindings: Record<string, ProviderGroupBinding> = {};
    const running: string[] = [];
    const router = harness({}, bindings, running);
    const first = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, reserveFor: 's1' });
    const second = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, reserveFor: 's2' });
    expect(first.kind === 'member' && second.kind === 'member' && first.member.key !== second.member.key).toBe(true);

    // 开始运行一轮之后按绑定计，不再重复计那份临时占用。
    if (first.kind !== 'member') throw new Error('expected a member');
    bindings.s1 = { providerId: 'anthropic', memberKey: first.member.key, at: 1 };
    running.push('s1');
    expect(router.running('anthropic', first.member.key)).toBe(1);
  });
});

describe('provider group quick picks with busy usable computers', () => {
  const FAST = member('device:fast:anthropic', 'device', 'fast');
  const SLOW = member('device:slow:anthropic', 'device', 'slow');

  function quickRouter(localLoad: number, fastLoad: number | null) {
    const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [LOCAL, FAST, SLOW] };
    const devices = ['fast', 'slow'].map((deviceId): DeviceLinkDeviceView => ({
      deviceId, name: deviceId, platform: 'win32', appVersion: '1.0.0', lastSeenAt: null,
      online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false,
    }));
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [view('anthropic')],
      localDeviceName: () => 'local',
      localRunning: async () => localLoad,
      listDevices: async () => devices,
      readDeviceProviders: (deviceId) => deviceId === 'fast' && fastLoad !== null
        ? Promise.resolve([view('anthropic')])
        : new Promise<ProviderView[]>(() => undefined),
      listReceivedShares: () => [],
      isMobilePlatform: () => false,
      now: () => 1_000,
    });
    const router = createProviderGroupRouter({
      directory, readGroup: () => config, listBindings: () => ({}), isTurnRunning: () => false,
      externalRunning: (_providerId, key) => key === FAST.key ? fastLoad ?? 0 : 0,
      now: () => 1_000, random: () => 0,
    });
    return { router, config };
  }

  it.each([
    { label: 'a full local computer while both remote catalogs stall', localLoad: 4, fastLoad: null, expected: LOCAL.key },
    { label: 'a free computer before a full one, despite order strategy', localLoad: 4, fastLoad: 1, expected: FAST.key },
    { label: 'the least busy computer when every resolved computer is full', localLoad: 6, fastLoad: 4, expected: FAST.key },
  ])('finishes within the quick window with $label', async ({ localLoad, fastLoad, expected }) => {
    vi.useFakeTimers();
    try {
      const { router } = quickRouter(localLoad, fastLoad);
      const done = vi.fn();
      void router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL }).then(done);
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS - 1);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: 'member', member: expect.objectContaining({ key: expected }),
      }));
      expect(done.mock.calls[0][0].resolved.find((resolved: ResolvedProviderGroupMember) => resolved.member.key === SLOW.key))
        .toMatchObject({ state: 'offline', pending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['paused', 'excluded', 'cooling', 'wrong-model'] as const)(
    'keeps waiting when the full resolved computer is %s', async (reason) => {
      vi.useFakeTimers();
      try {
        const { router, config } = quickRouter(4, null);
        if (reason === 'paused') config.members[0] = { ...LOCAL, paused: true };
        if (reason === 'cooling') router.markCooling('anthropic', LOCAL.key, 100_000);
        const done = vi.fn();
        void router.pick({
          providerId: 'anthropic', agentKind: 'claude-code', model: reason === 'wrong-model' ? 'missing-model' : MODEL,
          ...(reason === 'excluded' ? { exclude: new Set([LOCAL.key]) } : {}),
        }).then(done);
        await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS * 2);
        expect(done).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

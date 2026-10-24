// @vitest-environment jsdom
/**
 * 供应商组里展开一台电脑看它账号的剩余额度(provider-groups.md §10，2026-10-10 用户要求)：
 *   - 本机读本机账号；我的其他电脑按那台目录里的供应商读那台的账号；
 *   - 别人分享来的电脑、不在线的电脑不去读，直接说明；
 *   - 不是订阅类的供应商说明没有额度；一直读不到时不永远停在「正在读取」。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  local: [] as unknown[],
  byDevice: {} as Record<string, unknown[]>,
  deviceReads: [] as Array<string | undefined>,
  cardReads: [] as Array<[string | undefined, string | null]>,
  cards: {} as Record<string, { title: string }>,
  devices: [] as Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean; controlEnabled: boolean }> | null,
  presence: new Set<(snapshot: DeviceLinkPresenceSnapshot) => void>(),
  status: new Set<(snapshot: { status: string }) => void>(),
  getState: vi.fn(),
}));

vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: mocks.local }) }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => mocks.devices }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: (deviceId?: string) => {
    mocks.deviceReads.push(deviceId);
    return { providers: deviceId ? (mocks.byDevice[deviceId] ?? []) : [], loading: false, error: null, unsupported: false };
  },
}));
vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({
  useDeviceProviderSubscriptionCard: (provider: { id: string } | undefined, deviceId: string | null) => {
    mocks.cardReads.push([provider?.id, deviceId]);
    return provider ? (mocks.cards[`${deviceId ?? 'local'}:${provider.id}`] ?? null) : null;
  },
}));
vi.mock('@/components/status/QuotaHoverCard', () => ({
  QuotaHoverCard: ({ account, hideIdentity }: { account: { title: string }; hideIdentity?: boolean }) => (
    <div data-testid="quota-card" data-hide-identity={String(Boolean(hideIdentity))}>
      {account.title}
    </div>
  ),
}));

import { GroupMemberQuota, groupMemberQuotaTarget, type GroupMemberQuotaTarget } from '../GroupMemberQuota';

const claude = (id: string) => ({ id, name: 'Anthropic', source: 'builtin', connected: true, auth: { method: 'oauth', native: 'claude' } });
const apiKey = (id: string) => ({ id, name: 'OpenRouter', source: 'user', connected: true, auth: { method: 'api-key' } });

async function mountQuota(view: ReactElement) {
  const mounted = render(view);
  await act(async () => {});
  return mounted;
}

async function show(target: GroupMemberQuotaTarget, offline = false) {
  return mountQuota(<GroupMemberQuota id="quota" target={target} offline={offline} />);
}

beforeEach(() => {
  setDataOwnerGeneration('quota-owner');
  mocks.presence.clear();
  mocks.status.clear();
  mocks.getState.mockReset().mockResolvedValue({ linkStatus: 'online' });
  vi.stubGlobal('electronAPI', { deviceLink: {
    getState: mocks.getState,
    onPresenceChanged: (listener: (snapshot: DeviceLinkPresenceSnapshot) => void) => {
      mocks.presence.add(listener);
      return () => mocks.presence.delete(listener);
    },
    onStatusChanged: (listener: (snapshot: { status: string }) => void) => {
      mocks.status.add(listener);
      return () => mocks.status.delete(listener);
    },
  } });
  mocks.devices = [];
  mocks.local = [claude('anthropic')];
  mocks.byDevice = { mini: [claude('anthropic-1a2b')], pc: [apiKey('openrouter')] };
  mocks.deviceReads.length = 0;
  mocks.cardReads.length = 0;
  mocks.cards = { 'local:anthropic': { title: 'This computer’s Claude' }, 'mini:anthropic-1a2b': { title: 'Mini’s Claude' } };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GroupMemberQuota', () => {
  // Unit regression r4356429402: opening a stale-online row after the stopped
  // event must wait for the real initial state. Existing coverage only sent
  // future status events after mounting; initial failure must not permit reads.
  it.each(['stopped', 'unavailable'] as const)('waits for the initial relay state and keeps %s targets unread', async (state) => {
    vi.useFakeTimers();
    mocks.devices = null;
    let resolve!: (state: { linkStatus: string }) => void;
    let reject!: (error: Error) => void;
    mocks.getState.mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const mounted = await mountQuota(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.deviceReads.every(deviceId => deviceId === undefined)).toBe(true);
    expect(mocks.cardReads.every(([providerId, deviceId]) => providerId === undefined && deviceId === null)).toBe(true);
    await act(async () => {
      if (state === 'stopped') resolve({ linkStatus: 'stopped' });
      else reject(new Error('state temporarily unavailable'));
    });
    if (state === 'unavailable') act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByText(state === 'stopped' ? 'providerGroup.member.quota.offline' : 'providerGroup.member.quota.unavailable')).toBeTruthy();
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mounted.unmount();
  });

  // A state read launched before a newer status push cannot reverse that push.
  it.each([
    ['stopped', 'online', false],
    ['online', 'stopped', true],
  ] as const)('keeps the newer %s push when an older %s seed arrives', async (push, seed, readable) => {
    mocks.devices = null;
    let resolve!: (state: { linkStatus: string }) => void;
    mocks.getState.mockReturnValue(new Promise(done => { resolve = done; }));
    await mountQuota(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
    expect(screen.queryByTestId('quota-card')).toBeNull();
    act(() => mocks.status.forEach(listener => listener({ status: push })));
    await act(async () => resolve({ linkStatus: seed }));
    expect(Boolean(screen.queryByTestId('quota-card'))).toBe(readable);
    if (!readable) expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
  });

  it('discards an initial relay reply from the previous owner', async () => {
    mocks.devices = null;
    const replies: Array<(state: { linkStatus: string }) => void> = [];
    mocks.getState.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    setDataOwnerGeneration('next-owner');
    await act(async () => mounted.rerender(view()));
    await act(async () => replies[0]({ linkStatus: 'online' }));
    expect(screen.queryByTestId('quota-card')).toBeNull();
    await act(async () => replies[1]({ linkStatus: 'stopped' }));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit regression r4356185973 / provider-groups.md §10: a stopped relay
  // must disable a previously online member even before the directory clears,
  // and keep it disabled after null replaces the directory. Existing stop
  // coverage used an already-offline directory and offline=true group state.
  it('stops remote quota reads when relay stops despite stale online group and directory snapshots', async () => {
    const online = [{ deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true }];
    mocks.devices = online;
    const remote = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(remote());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'stopped' })));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    expect(mocks.deviceReads.at(-1)).toBeUndefined();
    for (const directory of [null, [...online]]) {
      mocks.devices = directory;
      mounted.rerender(remote());
      act(() => mocks.presence.forEach(listener => listener({ deviceId: 'mini', online: true, remoteControlEnabled: true } as DeviceLinkPresenceSnapshot)));
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    }
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'local', providerId: 'anthropic' }} offline={false} />);
    expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    mounted.rerender(remote());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mounted.unmount();
    expect(mocks.status.size).toBe(0);
    expect(mocks.presence.size).toBe(0);
  });

  // Unit regression r4355497190: listDevices retains its old offline array on
  // failure. Existing recovery only replaced that array. A target online push
  // must show its quota immediately, while another peer, disabled controls,
  // stopped relay and a different owner cannot enable the read.
  it('recovers from target presence while the device directory remains stale after a failed refresh', async () => {
    const device = { deviceId: 'mini', online: false, remoteControlEnabled: true, controlEnabled: true };
    mocks.devices = [device];
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view());
    const emit = (deviceId: string, remoteControlEnabled = true) => act(() => {
      const snapshot = { deviceId, online: true, remoteControlEnabled } as DeviceLinkPresenceSnapshot;
      mocks.presence.forEach(listener => listener(snapshot));
    });
    emit('other');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini', false);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.devices).toEqual([device]);
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'other', providerId: 'anthropic-1a2b' }} offline />);
    mounted.rerender(view());
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mocks.devices = [{ ...device, controlEnabled: false }];
    mounted.rerender(view());
    emit('mini');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    mocks.devices = [device];
    mounted.rerender(view());
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'stopped' })));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    setDataOwnerGeneration('another-owner');
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    mounted.unmount();
    expect(mocks.presence.size).toBe(0);
    expect(mocks.status.size).toBe(0);
  });

  // Unit regression: PR #6752 review r4344705878. The existing offline test only
  // checks that quota reads stop, not recovery from a stale offline group view.
  // Public component must read the target as soon as the shared device list says
  // it is online, even while the group still has a cached offline status.
  it('recovers quota reads from live device presence without waiting for the cached group status', async () => {
    vi.useFakeTimers();
    const view = <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.every(deviceId => deviceId === undefined)).toBe(true);
    mocks.devices = [{ deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true }];
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />);
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    // Losing connectivity/permission must stop reads even if the group still
    // reports online. An online presence alone cannot override either switch.
    for (const unavailable of [
      { online: false, remoteControlEnabled: true, controlEnabled: true },
      { online: true, remoteControlEnabled: false, controlEnabled: true },
      { online: true, remoteControlEnabled: true, controlEnabled: false },
    ]) {
      mocks.devices = [{ deviceId: 'mini', ...unavailable }];
      mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    }
  });

  it('reads this computer’s account for this computer', async () => {
    await show({ kind: 'local', providerId: 'anthropic' });
    expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
    // 行本身已说明是哪台电脑：卡片不再出标题行。
    expect(screen.getByTestId('quota-card').getAttribute('data-hide-identity')).toBe('true');
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  it('reads my other computer’s own account through its directory', async () => {
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.cardReads.at(-1)).toEqual(['anthropic-1a2b', 'mini']);
  });

  it('does not read a computer shared by someone else', async () => {
    await show({ kind: 'share' });
    expect(screen.getByText('providerGroup.member.quota.share')).toBeTruthy();
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
    expect(mocks.cardReads.every(([providerId]) => providerId === undefined)).toBe(true);
  });

  it('does not read an offline computer', async () => {
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }, true);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  it('says a provider without a subscription quota has none', async () => {
    await show({ kind: 'device', deviceId: 'pc', providerId: 'openrouter' });
    expect(screen.getByText('providerGroup.member.quota.none')).toBeTruthy();
  });

  it('stops saying it is reading when the quota never arrives', async () => {
    vi.useFakeTimers();
    mocks.cards = {};
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByText('providerGroup.member.quota.loading')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText('providerGroup.member.quota.unavailable')).toBeTruthy();
  });
});

describe('groupMemberQuotaTarget', () => {
  const member = (kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId = 'p') => ({ kind, agentDeviceId, providerId });

  it('reads the group computer for its own entry and this computer for itself', () => {
    // 本机的组。
    expect(groupMemberQuotaTarget(member('local', null), null, 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'mini'), null, 'self')).toEqual({ kind: 'device', deviceId: 'mini', providerId: 'p' });
    // 另一台电脑(studio)上的组：组所在电脑自己读 studio，组员就是本机时读本机。
    expect(groupMemberQuotaTarget(member('local', null), 'studio', 'self')).toEqual({ kind: 'device', deviceId: 'studio', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'self'), 'studio', 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('share', 'share:s1'), 'studio', 'self')).toEqual({ kind: 'share' });
  });
});

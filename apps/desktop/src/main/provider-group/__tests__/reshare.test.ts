/**
 * 供应商组的转分享(组所在电脑这一边，provider-sharing.md §4.3)：组里有分享来的电脑、组所在的供应商又分享给了别人时，
 * 把分享的人整体报给那台，按那台回来的结果决定能不能分给这个人；没问到之前一律当作没同意。
 */
import type { ProviderShareOwned, RemoteAgentCaps } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { reshareKeyFor } from '../../remote-agent/host/groupRelay';
import { createProviderGroupReshare, PROVIDER_GROUP_RESHARE_PENDING_POLL_MS } from '../reshare';

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const FRIEND = member('share:a1:anthropic', 'share', 'share:a1');
const MINI = member('device:mini:anthropic', 'device', 'mini');

function owned(members: Array<{ memberId: string; displayName: string }>, providerId = 'anthropic'): ProviderShareOwned {
  return {
    shareId: 'b-share',
    providerId,
    providerLabel: 'Anthropic',
    hostDeviceId: 'b-device',
    createdAt: '2026-10-15T00:00:00.000Z',
    members: members.map((m) => ({
      ...m,
      avatarUrl: null,
      region: 'global',
      status: 'active',
      joinedAt: '2026-10-15T00:00:00.000Z',
    })),
    requests: [],
  };
}

const CAPS: RemoteAgentCaps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048, reshareConsent: true };
const CAROL = reshareKeyFor('b-share', 'carol');
const DAVE = reshareKeyFor('b-share', 'dave');

function setup(options: {
  groups?: Record<string, ProviderGroupConfig>;
  shares?: ProviderShareOwned[] | null;
  caps?: RemoteAgentCaps;
  states?: Record<string, 'pending' | 'approved' | 'rejected'>;
} = {}) {
  let now = 1_000;
  let groups = options.groups ?? { anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, FRIEND, MINI] } };
  let shares: ProviderShareOwned[] | null = options.shares === undefined
    ? [owned([{ memberId: 'carol', displayName: 'Carol' }, { memberId: 'dave', displayName: 'Dave' }])]
    : options.shares;
  let states = { ...(options.states ?? {}) };
  const invoke = vi.fn(async (_agentDeviceId: string, request: unknown) => {
    const entries = (request as { entries: Array<{ key: string }> }).entries;
    return { entries: entries.flatMap((entry) => (states[entry.key] ? [{ key: entry.key, state: states[entry.key] }] : [])) };
  });
  const readCaps = vi.fn(async () => options.caps ?? CAPS);
  const changed = vi.fn();
  const reshare = createProviderGroupReshare({
    listGroups: () => groups,
    ownedShares: () => shares,
    readCaps,
    invoke,
    changed,
    now: () => now,
    log: { warn: vi.fn() },
  });
  return {
    reshare,
    invoke,
    readCaps,
    changed,
    setGroups: (next: Record<string, ProviderGroupConfig>) => { groups = next; },
    setShares: (next: ProviderShareOwned[] | null) => { shares = next; },
    setStates: (next: Record<string, 'pending' | 'approved' | 'rejected'>) => { states = { ...next }; },
    advance: (ms: number) => { now += ms; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider group reshare (group computer side)', () => {
  it('reports the people this computer shares the group with only to shared-in computers, and follows their answers', async () => {
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'pending' } });
    // 没问到之前一律当作没同意。
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    expect(env.invoke).toHaveBeenCalledWith('share:a1', {
      op: 'reshare',
      entries: [{ key: CAROL, name: 'Carol' }, { key: DAVE, name: 'Dave' }],
    });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
    expect(env.reshare.allows('share:a1', DAVE)).toBe(false);
    expect(env.reshare.allows('share:a1', undefined)).toBe(false);
    // 同账号电脑与本机不需要同意，也不会被问。
    expect(env.invoke.mock.calls.some(([id]) => id === 'mini')).toBe(false);
    expect(env.reshare.summary('anthropic', 'share:a1')).toEqual({
      support: 'supported',
      guests: [
        { memberId: 'carol', displayName: 'Carol', avatarUrl: null, state: 'approved' },
        { memberId: 'dave', displayName: 'Dave', avatarUrl: null, state: 'pending' },
      ],
    });
    expect(env.changed).toHaveBeenCalled();
  });

  it('does not report anything before this computer has read whom it shares with (an empty list would wipe consents)', async () => {
    const env = setup({ shares: null });
    await env.reshare.sync('test');
    expect(env.invoke).not.toHaveBeenCalled();
    expect(env.reshare.summary('anthropic', 'share:a1')).toBeNull();
  });

  it('treats an older shared-in computer as unable to agree', async () => {
    const env = setup({ caps: { ...CAPS, reshareConsent: undefined } });
    await env.reshare.sync('test');
    expect(env.invoke).not.toHaveBeenCalled();
    expect(env.reshare.needsUpdate('share:a1')).toBe(true);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    expect(env.reshare.summary('anthropic', 'share:a1')?.support).toBe('needs-update');
  });

  it('keeps the last answers when the shared-in computer cannot be reached, and asks again later', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.readCaps.mockRejectedValueOnce(new Error('offline'));
    await env.reshare.sync('test', { force: true });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
  });

  it('only asks again when the people change or the check interval passes, unless forced', async () => {
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'approved' } });
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    await env.reshare.sync('poll');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    env.setShares([owned([{ memberId: 'carol', displayName: 'Carol' }])]);
    await env.reshare.sync('owned');
    expect(env.invoke).toHaveBeenCalledTimes(2);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [{ key: CAROL, name: 'Carol' }] });
    await env.reshare.sync('view', { force: true });
    expect(env.invoke).toHaveBeenCalledTimes(3);
  });

  it('tells a computer that left every group to drop the people it was told about', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.setGroups({ anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] } });
    await env.reshare.sync('group');
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
  });

  it('forgets an approval right away when the shared-in computer refuses the person, then re-checks', async () => {
    const env = setup({ states: { [CAROL]: 'approved' } });
    await env.reshare.sync('test');
    env.setStates({ [CAROL]: 'rejected' });
    env.reshare.noteDenied('share:a1', CAROL);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(false);
    await vi.waitFor(() => expect(env.invoke).toHaveBeenCalledTimes(2));
    await env.reshare.sync('test');
    expect(env.reshare.summary('anthropic', 'share:a1')?.guests[0]?.state).toBe('rejected');
  });

  it('polls every minute while someone is still waiting', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'pending' } });
    await env.reshare.sync('test');
    expect(env.invoke).toHaveBeenCalledTimes(1);
    env.setStates({ [CAROL]: 'approved' });
    env.advance(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
    expect(env.invoke).toHaveBeenCalledTimes(2);
    expect(env.reshare.allows('share:a1', CAROL)).toBe(true);
    env.reshare.stop();
  });

  it('does not lose a change that arrives while a report is in flight', async () => {
    vi.useFakeTimers();
    const env = setup({ states: { [CAROL]: 'approved', [DAVE]: 'approved' } });
    let release!: () => void;
    env.readCaps.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(CAPS); }));
    const first = env.reshare.sync('test');
    // 报告进行中又有人变了：合并的报告不能被报告结束时重排的定时核对吞掉。
    env.setShares([owned([{ memberId: 'carol', displayName: 'Carol' }])]);
    env.reshare.kick('owned');
    release();
    await first;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.invoke).toHaveBeenLastCalledWith('share:a1', { op: 'reshare', entries: [{ key: CAROL, name: 'Carol' }] });
    env.reshare.stop();
  });

  it('shows nothing when this computer shares the provider with nobody', async () => {
    const env = setup({ shares: [] });
    await env.reshare.sync('test');
    // 没有分享的人也报一份空的：清掉那台上可能留着的旧请求。
    expect(env.invoke).toHaveBeenCalledWith('share:a1', { op: 'reshare', entries: [] });
    expect(env.reshare.summary('anthropic', 'share:a1')).toBeNull();
  });
});

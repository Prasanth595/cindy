/** Real directory → quota eligibility → scheduler → status projection, using only in-memory accounts. */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import { normalizeProviderGroupConfig, PROVIDER_GROUP_STRATEGIES, type ProviderGroupMember } from '../../../shared/providerGroup';
import { createProviderGroupDirectory } from '../directory';
import { createProviderGroupRouter } from '../router';

const NOW = 1_000_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const view = (id: string): ProviderView => ({
  id, name: id, agents: ['claude-code'], connected: true, auth: { method: 'oauth', native: 'claude' },
  models: { 'claude-code': [OPUS, SONNET].map((id) => ({ id, name: id, efforts: [], defaultEffort: null })) },
  routing: { 'claude-code': {} },
}) as unknown as ProviderView;
const snapshot = (fiveHour: number, sevenDay: number): ClaudeSubscriptionUsageSnapshot => ({
  updatedAt: NOW, fiveHour: { utilization: fiveHour, resetsAt: 3_000 }, sevenDay: { utilization: sevenDay, resetsAt: 80_000 },
});

function harness() {
  let now = NOW;
  const config = normalizeProviderGroupConfig({
    strategy: 'usage', members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic' }],
  }, 'anthropic')!;
  const usage = new Map<string, ClaudeSubscriptionUsageSnapshot | null>();
  const readUsage = vi.fn(async (member: ProviderGroupMember) => usage.get(member.key) ?? null);
  const directory = createProviderGroupDirectory({
    listLocalProviders: async () => [view('anthropic')], localDeviceName: () => 'local',
    listDevices: async () => [{ deviceId: 'mini', name: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true,
      isSelf: false, platform: 'darwin', appVersion: null, lastSeenAt: null, busy: false }],
    readDeviceProviders: async () => [view('anthropic')], listReceivedShares: () => [],
    isMobilePlatform: () => false, readClaudeUsage: readUsage, now: () => now,
  });
  const writeCooling = vi.fn();
  const router = createProviderGroupRouter({
    directory, readGroup: () => config, listBindings: () => ({}), isTurnRunning: () => false,
    coolingStore: { read: () => ({}), write: writeCooling }, now: () => now, random: () => 0,
  });
  const pick = (model = OPUS, reserveFor?: string) => router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model, reserveFor });
  return { config, usage, router, pick, writeCooling, readUsage, advance: (ms: number) => { now += ms; } };
}

describe('provider-group quota routing', () => {
  it.each(PROVIDER_GROUP_STRATEGIES)('keeps local task priority with the %s strategy despite higher usage, load and external pause', async (strategy) => {
    const context = harness();
    context.config.strategy = strategy;
    const local = context.config.members[0];
    const remote = context.config.members[1].key;
    local.limit = 1;
    local.paused = true;
    context.usage.set(local.key, snapshot(85, 90));
    context.usage.set(remote, snapshot(10, 20));
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: OPUS, localTask: true as const };
    expect(await context.router.pick({ ...input, reserveFor: 'local-running' })).toMatchObject({ kind: 'member', member: { key: local.key } });
    expect(context.router.running('anthropic', local.key)).toBe(1);
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: local.key } });
    expect(context.readUsage.mock.calls.every(([member]) => member.kind === 'local')).toBe(true);
    expect(await context.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
  });

  it.each(PROVIDER_GROUP_STRATEGIES)('applies quota prefiltering to local task priority with the %s strategy', async (strategy) => {
    const context = harness();
    context.config.strategy = strategy;
    context.config.members[0].paused = true;
    const remote = context.config.members[1].key;
    context.usage.set(remote, snapshot(40, 60));
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: OPUS, localTask: true as const };
    context.usage.set('local', snapshot(100, 5));
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    context.usage.set('local', snapshot(5, 100));
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    context.usage.set('local', { ...snapshot(10, 20), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 80_000 }] });
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    expect(await context.router.pick({ ...input, model: SONNET })).toMatchObject({ kind: 'member', member: { key: 'local' } });
    context.usage.set('local', null);
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: 'local' } });
  });

  it.each(PROVIDER_GROUP_STRATEGIES)('excludes an exhausted account for the %s strategy', async (strategy) => {
    const h = harness();
    h.config.strategy = strategy;
    const remote = h.config.members[1].key;
    h.usage.set('local', snapshot(100, 5));
    h.usage.set(remote, snapshot(40, 60));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    expect((await h.router.view('anthropic')).members[0]).toMatchObject({ state: 'cooling', coolingUntil: 3_000_000 });
    // Quota snapshots never overwrite error-derived cooldowns or turn a scoped limit into a persistent global one.
    expect(h.writeCooling).not.toHaveBeenCalled();
    h.usage.set('local', snapshot(5, 100));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.usage.set(remote, snapshot(100, 5));
    expect(await h.pick()).toMatchObject({ kind: 'unavailable' });
  });

  it('balances eligible accounts by usage, reserving simultaneous assignments immediately', async () => {
    const h = harness();
    const remote = h.config.members[1].key;
    h.usage.set('local', snapshot(20, 85));
    h.usage.set(remote, snapshot(55, 40));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.usage.set('local', snapshot(20, 40));
    h.usage.set(remote, snapshot(25, 43));
    const assignments = await Promise.all([h.pick(OPUS, 's1'), h.pick(OPUS, 's2')]);
    expect(assignments.map((p) => p.kind === 'member' ? p.member.key : p.kind)).toEqual(['local', remote]);
  });

  it('keeps model-specific limits out of the group-wide availability state', async () => {
    const h = harness();
    const remote = h.config.members[1].key;
    h.usage.set('local', { ...snapshot(10, 20), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 80_000 }] });
    h.usage.set(remote, snapshot(40, 60));
    expect(await h.pick(OPUS)).toMatchObject({ kind: 'member', member: { key: remote } });
    expect(await h.pick(SONNET)).toMatchObject({ kind: 'member', member: { key: 'local' } });
    expect((await h.router.view('anthropic')).members[0].state).toBe('available');
    expect((await h.router.view('anthropic', OPUS)).members[0].state).toBe('cooling');
    expect((await h.router.view('anthropic', SONNET)).members[0].state).toBe('available');
    expect(h.router.coolingUntil('anthropic', 'local')).toBeNull();
  });

  it('does not promise an earlier recovery time when an exhausted window has no reset', async () => {
    const h = harness();
    h.usage.set('local', { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: null } });
    h.router.markCooling('anthropic', 'local', NOW + 60_000);
    const status = (await h.router.view('anthropic')).members[0];
    expect(status.state).toBe('cooling');
    expect(status.coolingUntil).toBeUndefined();
  });

  it('falls back for missing/failed data and releases old quota blocks after reset', async () => {
    const h = harness();
    h.usage.set('local', snapshot(100, 10));
    const remote = h.config.members[1].key;
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.advance(2_000_000);
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: 'local' } });
    h.readUsage.mockRejectedValue(new Error('unreachable'));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: 'local' } });
  });
});

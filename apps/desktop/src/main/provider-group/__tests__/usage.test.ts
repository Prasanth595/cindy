import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import type { ProviderGroupMember } from '../../../shared/providerGroup';
import {
  createProviderGroupUsageReader, providerGroupUsageSnapshot, providerGroupUsageState,
  providerGroupCodexUsageSnapshot, providerGroupMemberUsageState,
  providerGroupCodexUsageFromReads,
  PROVIDER_GROUP_USAGE_MAX_AGE_MS, PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS,
} from '../usage';

const NOW = 1_000_000;
const snapshot = (fiveHour = 20, sevenDay = 40): ClaudeSubscriptionUsageSnapshot => ({
  updatedAt: NOW,
  fiveHour: { utilization: fiveHour, resetsAt: (NOW + 3_600_000) / 1000 },
  sevenDay: { utilization: sevenDay, resetsAt: (NOW + 86_400_000) / 1000 },
});

// Unit: group routing must not let a different model/harness bucket block or refresh this model's quota.
// Existing Claude cases do not cover Codex's per-bucket timestamps, WHAM slot or variable window durations.
describe('OpenAI group quota snapshots', () => {
  const bucket = (usedPercent: number, minutes = 300, resetsAt = 3_000) => ({
    updatedAt: NOW, primary: { usedPercent, windowMinutes: minutes, resetsAt },
    secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: 80_000 },
  });
  const state = (raw: unknown, model = 'gpt-5.3-codex', agentKind = 'codex') =>
    providerGroupMemberUsageState({ codexUsage: providerGroupCodexUsageSnapshot(raw) }, model, NOW, agentKind);

  it('uses only the selected model bucket, and only WHAM for bridge/Pi', () => {
    const raw = { appServerBuckets: {
      codex: bucket(20), spark: { ...bucket(100), limitName: 'GPT-5.3-Codex-Spark' },
    }, webSnapshot: bucket(100) };
    expect(state(raw)).toMatchObject({ limited: false, usagePercent: 20 });
    expect(state(raw, 'gpt-5.3-codex-spark')).toMatchObject({ limited: true, resetAtMs: 3_000_000 });
    expect(state(raw, 'gpt-5.3-codex', 'pi').limited).toBe(true);
    expect(state(raw, 'chatgpt/gpt-5.3-codex', 'claude-code').limited).toBe(true);
    expect(state({ appServerBuckets: raw.appServerBuckets }, 'gpt-5.3-codex', 'pi'))
      .toMatchObject({ limited: false, usagePercent: null });
    expect(state({ appServerBuckets: { spark: raw.appServerBuckets.spark } }))
      .toMatchObject({ limited: false, usagePercent: null });
  });

  it.each([NOW - PROVIDER_GROUP_USAGE_MAX_AGE_MS - 1, NOW + 60_001, null])(
    'does not refresh a stale/undated model bucket from another bucket (%s)', (updatedAt) => {
      const raw = { appServerBuckets: { codex: bucket(5), spark: { ...bucket(100), updatedAt, limitName: 'GPT-5.3-Codex-Spark' } } };
      expect(state(raw, 'gpt-5.3-codex-spark')).toMatchObject({ limited: false, usagePercent: null });
    },
  );

  it('does not invent empty quota for expired/malformed windows, and supports single-window plans', () => {
    expect(state({ ...bucket(100), primary: { usedPercent: 100, resetsAt: NOW / 1000 } }))
      .toMatchObject({ limited: false, usagePercent: null });
    expect(state({ ...bucket(20), primary: { usedPercent: '0' } }))
      .toMatchObject({ limited: false, usagePercent: null });
    expect(state({ ...bucket(100), primary: { usedPercent: 100 } }))
      .toMatchObject({ limited: true, resetAtMs: null });
    expect(state({ ...bucket(100), primary: null }))
      .toMatchObject({ limited: false, usagePercent: 20, weeklyResetAtMs: 80_000_000, fiveHourResetAtMs: null });
    expect(state({ ...bucket(20), primary: { usedPercent: 10, windowMinutes: 60, resetsAt: 3_000 } }))
      .toMatchObject({ usagePercent: 20, fiveHourResetAtMs: null });
  });

  it('preserves legacy single-bucket/web snapshots while dropping identity and credit offers', () => {
    const raw = { ...bucket(35), accountId: 'private', resetOffer: { idempotencyKey: 'private' } };
    const parsed = providerGroupCodexUsageSnapshot(raw);
    expect(state(parsed)).toMatchObject({ usagePercent: 35, weeklyResetAtMs: 80_000_000, fiveHourResetAtMs: 3_000_000 });
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(state({ ...bucket(65), source: 'openai-web' }, 'gpt-5', 'pi').usagePercent).toBe(65);
  });

  it('uses freshly read native quotas without depending on an open task or refreshing stale WHAM data', () => {
    const stale = { ...bucket(100), updatedAt: NOW - PROVIDER_GROUP_USAGE_MAX_AGE_MS - 1 };
    const fresh = providerGroupCodexUsageFromReads({ appServerBuckets: { codex: stale }, webSnapshot: stale }, {
      rateLimits: { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 3_000 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 3_000 } } },
    }, NOW);
    expect(state(fresh)).toMatchObject({ limited: false, usagePercent: 25 });
    expect(state(fresh, 'gpt-5.3-codex', 'pi')).toMatchObject({ limited: false, usagePercent: null });
    expect(state(providerGroupCodexUsageFromReads(bucket(40), null, NOW)).usagePercent).toBe(40);
  });
});
const member = (kind: ProviderGroupMember['kind'], agentDeviceId: string | null, providerId = 'anthropic'): ProviderGroupMember => ({
  key: `${kind}:${agentDeviceId}:${providerId}`, kind, agentDeviceId, providerId, paused: false, limit: 4, weight: 1,
});
const REMOTE = member('device', 'mini');

afterEach(() => vi.useRealTimers());

describe('provider group quota eligibility', () => {
  it.each([[100, 10], [10, 100]])('excludes exhausted windows before comparing usage (%s, %s)', (fiveHour, sevenDay) => {
    expect(providerGroupUsageState(snapshot(fiveHour, sevenDay), 'opus', NOW).limited).toBe(true);
  });

  it('uses both windows and only the selected model’s weekly window', () => {
    const value = { ...snapshot(), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 3_000 }] };
    expect(providerGroupUsageState(value, 'claude-opus-5-5', NOW).limited).toBe(true);
    expect(providerGroupUsageState(value, 'claude-sonnet-5', NOW)).toMatchObject({ limited: false, usagePercent: 40 });
    expect(providerGroupUsageState(value, null, NOW).limited).toBe(false);
    expect(providerGroupUsageState(snapshot(85, 20), 'opus', NOW).usagePercent).toBe(85);
    expect(providerGroupUsageState(snapshot(20, 85), 'opus', NOW).usagePercent).toBe(85);
  });

  it('waits for the last exhausted window and never borrows another window’s reset', () => {
    expect(providerGroupUsageState(snapshot(100, 100), 'opus', NOW).resetAtMs).toBe(NOW + 86_400_000);
    const unknownReset = { ...snapshot(100, 100), fiveHour: { utilization: 100 } };
    expect(providerGroupUsageState(unknownReset, 'opus', NOW)).toMatchObject({ limited: true, resetAtMs: null });
  });

  it('does not keep blocking a reset window or score it as zero before fresh data arrives', () => {
    const value = { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: NOW / 1000 } };
    expect(providerGroupUsageState(value, 'opus', NOW)).toEqual({
      limited: false, resetAtMs: null, usagePercent: null, weeklyResetAtMs: NOW + 86_400_000, fiveHourResetAtMs: null,
    });
  });

  it('reports when unused quota resets, but not for used-up, past or unknown resets', () => {
    expect(providerGroupUsageState(snapshot(20, 40), 'opus', NOW))
      .toMatchObject({ weeklyResetAtMs: NOW + 86_400_000, fiveHourResetAtMs: NOW + 3_600_000 });
    expect(providerGroupUsageState(snapshot(100, 100), 'opus', NOW))
      .toMatchObject({ weeklyResetAtMs: null, fiveHourResetAtMs: null });
    const unknown = { ...snapshot(), fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 10, resetsAt: (NOW - 1) / 1000 } };
    expect(providerGroupUsageState(unknown, 'opus', NOW)).toMatchObject({ weeklyResetAtMs: null, fiveHourResetAtMs: null });
    expect(providerGroupUsageState(null, 'opus', NOW)).toMatchObject({ weeklyResetAtMs: null, fiveHourResetAtMs: null });
  });

  it('keeps unknown and stale data distinct from low usage', () => {
    for (const raw of [null, {}, { ...snapshot(), updatedAt: null }, { ...snapshot(), updatedAt: NOW + 120_000 },
      { ...snapshot(), fiveHour: null }, { ...snapshot(), sevenDay: { utilization: '0' } }]) {
      expect(providerGroupUsageState(raw, 'opus', NOW)).toMatchObject({ limited: false, usagePercent: null });
    }
    expect(providerGroupUsageState(snapshot(100, 100), 'opus', NOW + PROVIDER_GROUP_USAGE_MAX_AGE_MS + 1))
      .toMatchObject({ limited: false, usagePercent: null });
    expect(providerGroupUsageState({ ...snapshot(), sevenDay: null, fiveHour: { utilization: 100 } }, 'opus', NOW).limited).toBe(true);
  });

  it('reuses the rejected-window check and sanitizes remote data without exposing account identity', () => {
    const value = { ...snapshot(), rateLimitStatus: 'rejected', representativeClaim: 'five_hour',
      accountFingerprint: 'private-account', scoped: [null, { modelDisplayName: 8, utilization: 100 }] };
    expect(providerGroupUsageState(value, 'opus', NOW).limited).toBe(true);
    expect(providerGroupUsageSnapshot(value, NOW)).not.toHaveProperty('accountFingerprint');
    expect(providerGroupUsageSnapshot(value, NOW)?.scoped).toEqual([]);
  });
});

describe('provider group usage reads', () => {
  function harness() {
    let now = NOW;
    let current = true;
    const readLocal = vi.fn(async (_providerId: string) => snapshot());
    const readRemote = vi.fn(async (_device: string, _providerId: string) => snapshot());
    const reader = createProviderGroupUsageReader({ readLocal, readRemote, parseSnapshot: providerGroupUsageSnapshot, now: () => now, isCurrent: () => current });
    return { reader, readLocal, readRemote, advance: (ms: number) => { now += ms; }, leave: () => { current = false; } };
  }

  it('reads the correct device and provider, coalesces remote reads, and refreshes local snapshots', async () => {
    const h = harness();
    await Promise.all([h.reader.read(REMOTE), h.reader.read(REMOTE)]);
    expect(h.readRemote).toHaveBeenCalledExactlyOnceWith('mini', 'anthropic');
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(1);
    await h.reader.read(member('device', 'mini', 'anthropic-second'));
    expect(h.readRemote).toHaveBeenLastCalledWith('mini', 'anthropic-second');
    await h.reader.read(member('local', null));
    await h.reader.read(member('local', null));
    expect(h.readLocal).toHaveBeenCalledTimes(2);
    h.advance(15_001);
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(3);
    h.reader.invalidate();
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(4);
  });

  it('never requests another person’s subscription quota', async () => {
    const h = harness();
    expect(await h.reader.read(member('share', 'share:s1'))).toBeNull();
    expect(await h.reader.read(member('device', 'share:s1'))).toBeNull();
    expect(h.readLocal).not.toHaveBeenCalled();
    expect(h.readRemote).not.toHaveBeenCalled();
  });

  it('falls back on unsupported peers or failed reads without caching an invented zero', async () => {
    const h = harness();
    h.readRemote.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(h.readRemote).toHaveBeenCalledTimes(1);
  });

  it('bounds a slow read, keeps one request in flight and uses its eventual result', async () => {
    vi.useFakeTimers();
    const h = harness();
    let complete!: (value: ClaudeSubscriptionUsageSnapshot) => void;
    h.readRemote.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const first = h.reader.read(REMOTE);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    expect(await first).toBeNull();
    const second = h.reader.read(REMOTE);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    expect(await second).toBeNull();
    expect(h.readRemote).toHaveBeenCalledTimes(1);
    complete(snapshot(35, 45));
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.reader.read(REMOTE)).toMatchObject({ fiveHour: { utilization: 35 } });
  });

  it('drops an in-flight snapshot when the Cindy account changes', async () => {
    const h = harness();
    h.readRemote.mockImplementation(async () => { h.leave(); return snapshot(); });
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(await h.reader.read(member('local', null))).toBeNull();
    expect(h.readLocal).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  createAgentPrewarmer,
  isAgentPrewarmEligible,
  type AgentPrewarmDeps,
  type AgentPrewarmSessionRow,
} from '../agentPrewarm.js';

function harness(maxWarm = 2) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const start = vi.fn<AgentPrewarmDeps['start']>(async () => true);
  const closeIfUnused = vi.fn<AgentPrewarmDeps['closeIfUnused']>(async () => {});
  const prewarmer = createAgentPrewarmer(
    {
      start,
      closeIfUnused,
      setTimer: (fn) => {
        const id = ++nextTimer;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => timers.delete(id as number),
      log: { info: vi.fn(), warn: vi.fn() },
    },
    { maxWarm, idleMs: 1_000 },
  );
  const fireAll = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
  };
  return { prewarmer, start, closeIfUnused, fireAll, timers };
}

describe('Agent prewarm lifecycle', () => {
  it('keeps at most the newest unused runtimes and closes the oldest', async () => {
    const { prewarmer, closeIfUnused } = harness(2);
    for (const id of ['a', 'b', 'c']) await prewarmer.request(id, {});
    expect(prewarmer.warmSessionIds()).toEqual(['b', 'c']);
    expect(closeIfUnused.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('closes an unused runtime after the idle window but never one a send has used', async () => {
    const { prewarmer, closeIfUnused, fireAll, start } = harness();
    await prewarmer.request('idle', {});
    await prewarmer.request('used', {});
    // Typing again in a warm task only extends its window; it does not start twice.
    await expect(prewarmer.request('idle', {})).resolves.toBe('warm');
    prewarmer.markUsed('used');
    fireAll();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    expect(closeIfUnused.mock.calls.map(([id]) => id)).toEqual(['idle']);
    expect(prewarmer.warmSessionIds()).toEqual([]);
  });

  it('does not track a task whose runtime was not started by prewarm', async () => {
    const { prewarmer, start, timers } = harness();
    start.mockResolvedValueOnce(false);
    start.mockRejectedValueOnce(new Error('credential switch busy'));
    await expect(prewarmer.request('live', {})).resolves.toBe('skipped');
    await expect(prewarmer.request('broken', {})).resolves.toBe('skipped');
    expect(prewarmer.warmSessionIds()).toEqual([]);
    expect(timers.size).toBe(0);
  });
  it('does not hand a runtime to idle reclaim when a send took it over while it was starting', async () => {
    const { prewarmer, closeIfUnused, fireAll, start, timers } = harness();
    let finishStart!: (started: boolean) => void;
    start.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishStart = resolve)));
    const pending = prewarmer.request('racing', {});
    prewarmer.markUsed('racing');
    finishStart(true);
    await pending;
    expect(prewarmer.warmSessionIds()).toEqual([]);
    expect(timers.size).toBe(0);
    fireAll();
    await Promise.resolve();
    expect(closeIfUnused).not.toHaveBeenCalled();
    // A later prewarm of the same task starts tracking normally again.
    await prewarmer.request('racing', {});
    expect(prewarmer.warmSessionIds()).toEqual(['racing']);
  });
  it('counts runtimes that are still starting against the cap', async () => {
    const { prewarmer, start } = harness(2);
    const finish: Array<(started: boolean) => void> = [];
    start.mockImplementation(() => new Promise<boolean>((resolve) => finish.push(resolve)));
    const outcomes = ['a', 'b', 'c', 'd'].map((id) => prewarmer.request(id, {}));
    // Only two may be launched at once; the rest are skipped, not queued behind them.
    expect(start).toHaveBeenCalledTimes(2);
    await expect(outcomes[2]).resolves.toBe('skipped');
    await expect(outcomes[3]).resolves.toBe('skipped');
    finish.forEach((resolve) => resolve(true));
    await Promise.all(outcomes);
    expect(prewarmer.warmSessionIds()).toEqual(['a', 'b']);
  });
  describe('eligibility', () => {
    const row = (patch: Partial<AgentPrewarmSessionRow> = {}): AgentPrewarmSessionRow => ({
      status: 'active',
      source: 'desktop',
      workingDir: '/repo',
      remoteHostId: null,
      agentDeviceId: null,
      orcaRole: null,
      sdkSessionId: 'native-1',
      ...patch,
    });

    it('prewarms only a task the user has already sent in, so typing alone never runs a directory\'s hooks', () => {
      expect(isAgentPrewarmEligible(row())).toBe(true);
      expect(isAgentPrewarmEligible(row({ sdkSessionId: null }))).toBe(false);
    });

    it.each([
      { status: 'archived' },
      { source: 'scheduler' },
      { workingDir: null },
      { remoteHostId: 'ssh-1' },
      { agentDeviceId: 'other-computer' },
      { orcaRole: 'worker' },
    ])('skips %o', (patch) => {
      expect(isAgentPrewarmEligible(row(patch))).toBe(false);
    });

    it('skips a missing task', () => {
      expect(isAgentPrewarmEligible(undefined)).toBe(false);
    });
  });
  it('lets a send that arrives while the close is queued keep the runtime', async () => {
    const { prewarmer, closeIfUnused, fireAll } = harness();
    let stillUnused!: () => boolean;
    closeIfUnused.mockImplementationOnce(async (_id, check) => {
      stillUnused = check;
    });
    await prewarmer.request('racing', {});
    fireAll();
    await Promise.resolve();
    // The idle close is queued behind the send lock; the send marks the runtime used first.
    expect(stillUnused()).toBe(true);
    prewarmer.markUsed('racing');
    expect(stillUnused()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStalledOutboundRecovery } from '../stalledOutboundRecovery';

function make(over: { canRecover?: boolean; reopening?: boolean } = {}) {
  const state = { canRecover: over.canRecover ?? true, reopening: over.reopening ?? false, relayOnline: true };
  const trigger = vi.fn();
  const recovery = createStalledOutboundRecovery({
    canRecover: () => state.canRecover,
    trigger,
    isReopening: () => state.reopening,
    isRelayOnline: () => state.relayOnline,
  });
  return { state, trigger, recovery };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createStalledOutboundRecovery', () => {
  it('只有掉线 / 路由离线 / 重新上线通知界面重置;可靠层重置与定时重试静默', async () => {
    const { trigger, recovery } = make();
    recovery.recover('dev-a', 'link-lost');
    recovery.recover('dev-b', 'route-offline');
    recovery.recover('dev-c', 'presence-online');
    recovery.recover('dev-d', 'transport-reset');
    recovery.onGaveUp('dev-e');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger.mock.calls).toEqual([
      ['dev-a', { notifyReset: true }],
      ['dev-b', { notifyReset: true }],
      ['dev-c', { notifyReset: true }],
      ['dev-d', { notifyReset: false }],
      ['dev-e', { notifyReset: false }],
    ]);
  });

  it('重开循环已在跑时不重复触发', () => {
    const { trigger, recovery } = make({ reopening: true });
    recovery.recover('dev-a', 'link-lost');
    recovery.recover('dev-a', 'route-offline');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('不再需要重开时,到点的定时器只清理自己,不触发', async () => {
    const { state, trigger, recovery } = make();
    recovery.onGaveUp('dev-a');
    state.canRecover = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger).not.toHaveBeenCalled();
    expect(recovery.hasPendingRetry('dev-a')).toBe(false);
    // 退避也一起清零:下一次放弃从 60 秒算。
    state.canRecover = true;
    recovery.onGaveUp('dev-a');
    expect(recovery.pendingRetryDelayMs('dev-a')).toBe(60_000);
  });

  it('退避逐轮翻倍;新的掉线事件或 reset 让它从头算', async () => {
    const { recovery } = make();
    recovery.onGaveUp('dev-a');
    await vi.advanceTimersByTimeAsync(60_000);
    recovery.onGaveUp('dev-a');
    expect(recovery.pendingRetryDelayMs('dev-a')).toBe(120_000);

    recovery.recover('dev-a', 'route-offline');
    expect(recovery.hasPendingRetry('dev-a')).toBe(false);
    recovery.onGaveUp('dev-a');
    expect(recovery.pendingRetryDelayMs('dev-a')).toBe(60_000);

    recovery.reset('dev-a');
    expect(recovery.hasPendingRetry('dev-a')).toBe(false);
  });

  it('本机 relay 离线时到点的重试保留恢复状态,重新上线后接着重开且不重复通知界面', async () => {
    const { state, trigger, recovery } = make();
    recovery.onGaveUp('dev-a');
    state.relayOnline = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger).not.toHaveBeenCalled();
    expect(recovery.isRecovering('dev-a')).toBe(true);

    state.relayOnline = true;
    recovery.resumeAfterRelayOnline();
    expect(trigger.mock.calls).toEqual([['dev-a', { notifyReset: false }]]);
  });

  it('relay 重新上线时已不需要重开的设备直接移出恢复状态', () => {
    const { state, trigger, recovery } = make();
    recovery.onGaveUp('dev-a');
    state.canRecover = false;
    recovery.resumeAfterRelayOnline();
    expect(trigger).not.toHaveBeenCalled();
    expect(recovery.isRecovering('dev-a')).toBe(false);
    expect(recovery.hasPendingRetry('dev-a')).toBe(false);
  });

  it('dispose 后已排期的定时器不会再触发', async () => {
    const { trigger, recovery } = make();
    recovery.onGaveUp('dev-a');
    recovery.onGaveUp('dev-b');
    recovery.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(trigger).not.toHaveBeenCalled();
  });
});

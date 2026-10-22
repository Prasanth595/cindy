/**
 * 冷启动网络恢复重试的时序编排。
 *
 * 守护的契约:开机自启时网络未就绪导致 refresh 拿不到连接(status 0)后,
 * 进程要自己再试,而不是停在登录页等用户重新输入验证码;同时不能把
 * 429 / Retry-After 的等待、已登出、用户手动登录这些情况也拖进自动重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLD_START_NETWORK_RETRY_DELAYS_MS,
  startColdStartNetworkRecovery,
} from '../coldStartNetworkRecovery';

function harness(overrides: Partial<Parameters<typeof startColdStartNetworkRecovery>[0]> = {}) {
  const retry = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const deps = {
    isCurrent: () => true,
    isSignedOut: () => true,
    retry,
    delaysMs: [1_000, 2_000],
    ...overrides,
  };
  return { ...deps, retry, handle: startColdStartNetworkRecovery(deps) };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('cold start network recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('网络恢复后重试一次即停止,不再继续排下一轮', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.retry).toHaveBeenCalledTimes(1);
    h.handle.cancel();
  });

  it('仍然失败时按节奏继续重试,直到节奏用完', async () => {
    const onExhausted = vi.fn();
    const retry = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const h = harness({ retry, onExhausted });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(onExhausted).toHaveBeenCalledWith(2);
    h.handle.cancel();
  });

  it('用户已手动登录 / 登出后不再重试', async () => {
    let current = true;
    const h = harness({ isCurrent: () => current });
    current = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.retry).not.toHaveBeenCalled();
    h.handle.cancel();
  });

  it('已经离开未登录状态(例如进入本地模式)后不再重试', async () => {
    let signedOut = true;
    const h = harness({ isSignedOut: () => signedOut });
    signedOut = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.retry).not.toHaveBeenCalled();
    h.handle.cancel();
  });

  it('cancel 取消尚未触发的重试', async () => {
    const h = harness();
    h.handle.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.retry).not.toHaveBeenCalled();
  });

  it('retry 抛异常也继续排下一轮,不会让恢复链断掉', async () => {
    const onError = vi.fn();
    const retry = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);
    const h = harness({ retry, onError });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    h.handle.cancel();
  });

  it('默认节奏覆盖开机后网络就绪的常见延迟,且有界', () => {
    expect(COLD_START_NETWORK_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
    expect(COLD_START_NETWORK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(120_000);
  });
});

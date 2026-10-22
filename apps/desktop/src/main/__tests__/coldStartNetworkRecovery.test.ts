/**
 * 冷启动网络恢复重试的时序编排。
 *
 * 守护的契约:开机自启时网络未就绪导致 refresh 拿不到连接(status 0)后,
 * 进程要自己再试,而不是停在登录页等用户重新输入验证码;同时 429 / 5xx /
 * 确定性失效都必须停下,不能按短间隔继续撞服务端。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLD_START_NETWORK_RETRY_DELAYS_MS,
  ColdStartRecoveryLifecycle,
  startColdStartNetworkRecovery,
  type ColdStartNetworkRecoveryDeps,
} from '../coldStartNetworkRecovery';

function harness(overrides: Partial<ColdStartNetworkRecoveryDeps> = {}) {
  const retry = vi
    .fn<() => Promise<'recovered' | 'continue' | 'stop'>>()
    .mockResolvedValue('recovered');
  const deps: ColdStartNetworkRecoveryDeps = {
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

  it('恢复成功后停止,不再继续排下一轮', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.retry).toHaveBeenCalledTimes(1);
    h.handle.cancel();
  });

  it('仍是传输层失败时按节奏继续,直到节奏用完', async () => {
    const onExhausted = vi.fn();
    const retry = vi
      .fn<() => Promise<'recovered' | 'continue' | 'stop'>>()
      .mockResolvedValue('continue');
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

  it('429 / 5xx / 确定性失效返回 stop 后立即停止', async () => {
    const retry = vi
      .fn<() => Promise<'recovered' | 'continue' | 'stop'>>()
      .mockResolvedValue('stop');
    const h = harness({ retry });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
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

  it('重试抛异常时记录并停止,不继续撞服务端', async () => {
    const onError = vi.fn();
    const retry = vi
      .fn<() => Promise<'recovered' | 'continue' | 'stop'>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');
    const h = harness({ retry, onError });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    h.handle.cancel();
  });

  it('默认节奏覆盖开机后网络就绪的常见延迟,且有界', () => {
    expect(COLD_START_NETWORK_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
    expect(COLD_START_NETWORK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(120_000);
  });
});

describe('cold start recovery lifecycle', () => {
  function lifecycleHarness() {
    let epoch = 1;
    let mode = 'signed-out';
    const cancel = vi.fn();
    const start = vi.fn(() => cancel);
    const lifecycle = new ColdStartRecoveryLifecycle({
      epoch: () => epoch,
      mode: () => mode,
      start,
    });
    return {
      lifecycle,
      start,
      cancel,
      bumpEpoch: () => {
        epoch += 1;
      },
      setMode: (next: string) => {
        mode = next;
      },
      isCurrent: () => lifecycle.isCurrent(),
    };
  }

  it('提交前 request 不创建恢复器,提交后再 arm 才创建', () => {
    const h = lifecycleHarness();
    h.lifecycle.request();
    expect(h.start).not.toHaveBeenCalled();
    h.bumpEpoch();
    h.lifecycle.arm();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.isCurrent()).toBe(true);
  });

  it('提交内部的 clearAuth 会取消已存在的恢复器;之后的 arm 仍能重新启动', () => {
    const h = lifecycleHarness();
    h.lifecycle.request();
    h.lifecycle.arm();
    const firstCancel = h.cancel;
    // 未登录态提交内部调用 clearAuth → cancel,并推进代次。
    h.lifecycle.cancel();
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(h.isCurrent()).toBe(false);

    h.bumpEpoch();
    h.lifecycle.request();
    h.lifecycle.arm();
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.isCurrent()).toBe(true);
  });

  it('已经离开未登录态时不创建恢复器', () => {
    const h = lifecycleHarness();
    h.setMode('local');
    h.lifecycle.request();
    h.lifecycle.arm();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('每进程只启动一条恢复链,重复 request / arm 不再创建', () => {
    const h = lifecycleHarness();
    h.lifecycle.request();
    h.lifecycle.arm();
    h.lifecycle.request();
    h.lifecycle.arm();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('手动登录先递增代次时，旧恢复器立即失效(即使会话仍是 signed-out)', () => {
    const h = lifecycleHarness();
    h.lifecycle.request();
    h.lifecycle.arm();
    expect(h.isCurrent()).toBe(true);
    // completeLogin() 先 ++authStateEpoch，再提交 cloud owner；此刻 mode 仍是
    // signed-out，旧恢复器不能借这个窗口再跑一次 initialize()。
    h.bumpEpoch();
    expect(h.isCurrent()).toBe(false);
  });

  it('已启动的链不会被迟到的 request 重置节奏', () => {
    const h = lifecycleHarness();
    h.lifecycle.request();
    h.lifecycle.arm();
    const cancel = h.cancel;
    // 冷启动超时转后台后原流程迟到失败，会再走一次失败分支。
    h.lifecycle.request();
    expect(cancel).not.toHaveBeenCalled();
    h.lifecycle.arm();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('重试自身再失败时允许重新起链，但受总链数上限约束', () => {
    const onExhausted = vi.fn();
    const cancel = vi.fn();
    const start = vi.fn(() => cancel);
    let epoch = 1;
    const lifecycle = new ColdStartRecoveryLifecycle({
      epoch: () => epoch,
      mode: () => 'signed-out',
      start,
      maxChains: 2,
      onExhausted,
    });
    // 重试自身再失败:request → account-free 提交内部 clearAuth(keepPending)
    // → arm。总启动链数受 maxChains 约束。
    const chain = () => {
      lifecycle.request();
      lifecycle.cancel({ keepPending: true });
      epoch += 1;
      lifecycle.arm();
    };
    chain();
    expect(start).toHaveBeenCalledTimes(1);
    chain();
    expect(start).toHaveBeenCalledTimes(2);
    chain();
    expect(start).toHaveBeenCalledTimes(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});

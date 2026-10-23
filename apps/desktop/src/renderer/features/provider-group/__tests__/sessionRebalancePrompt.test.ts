// @vitest-environment jsdom

/**
 * 发送前换号(provider-groups.md §6.2「任务进行中换号」)：2026-10-22 用户裁决改成输入框上方的提示，不再弹窗。
 * 不操作 = 这条照常发到当前账号；点「切换」= 这条先换过去；点 × = 任务所在电脑记下这一轮不再提醒；组里设了自动换号 = 不提示直接换。
 * 提议在任务空闲时预先问好，发送时没有问好的提议(问不到、旧版本、还没问完)就立即照常发送，不多等一次往返。
 * 用户看到什么、任务所在电脑收到什么由这里决定，所以从发送前调用的真实入口验证。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  armSessionRebalance,
  dismissSessionRebalance,
  prefetchSessionRebalance,
  SESSION_REBALANCE_CACHE_MS,
  takeSessionRebalance,
  useSessionRebalanceHint,
} from '../sessionRebalancePrompt';

const MINI = 'device:mini:anthropic';
const suggestion = (kind: 'ask' | 'auto') => ({
  kind,
  memberKey: MINI,
  label: 'Mini',
  quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 7 * 86_400_000 },
});

function setup(reply: () => Promise<unknown>) {
  const command = vi.fn((request: { action: string }) =>
    request.action === 'rebalance-suggestion' ? reply() : Promise.resolve({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { providerGroup: { command } };
  const sent = (action: string) => command.mock.calls.map(([request]) => request).filter((r) => r.action === action);
  return { command, sent };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('session rebalance hint', () => {
  it('sends on the current account without asking when the user leaves the hint alone', async () => {
    const h = setup(async () => suggestion('ask'));
    await prefetchSessionRebalance('s1');
    expect(takeSessionRebalance('s1')).toBeUndefined();
    expect(h.sent('rebalance-decision')).toEqual([]);
  });

  it('switches the next message after “Switch”, and undo puts it back', async () => {
    const h = setup(async () => suggestion('ask'));
    await prefetchSessionRebalance('s1');
    armSessionRebalance('s1', undefined, true);
    armSessionRebalance('s1', undefined, false);
    expect(takeSessionRebalance('s1')).toBeUndefined();

    await prefetchSessionRebalance('s1');
    armSessionRebalance('s1', undefined, true);
    const record = takeSessionRebalance('s1');
    expect(record).toBeTypeOf('function');
    await record!('message-a');
    expect(h.sent('rebalance-decision')).toEqual([
      { action: 'rebalance-decision', sessionId: 's1', memberKey: MINI, remember: false, clientId: 'message-a' },
    ]);
    // 一次提议只管一条消息。
    expect(takeSessionRebalance('s1')).toBeUndefined();
  });

  it('switches without a hint when the group switches automatically', async () => {
    const h = setup(async () => suggestion('auto'));
    const { result } = renderHook(() => useSessionRebalanceHint('s2', undefined, true));
    await act(async () => { await prefetchSessionRebalance('s2'); });
    expect(result.current).toBeNull();
    await takeSessionRebalance('s2')!('message-a');
    expect(h.sent('rebalance-decision')).toHaveLength(1);
  });

  it('shows the hint while idle and hides it on × while the task host snoozes it', async () => {
    const h = setup(async () => suggestion('ask'));
    const { result, rerender } = renderHook(({ idle }) => useSessionRebalanceHint('s3', undefined, idle), { initialProps: { idle: true } });
    await act(async () => { await prefetchSessionRebalance('s3'); });
    expect(result.current).toMatchObject({ suggestion: { memberKey: MINI }, armed: false });
    act(() => armSessionRebalance('s3', undefined, true));
    expect(result.current?.armed).toBe(true);
    rerender({ idle: false });
    expect(result.current).toBeNull();
    rerender({ idle: true });
    await act(async () => { await dismissSessionRebalance('s3', undefined); });
    expect(result.current).toBeNull();
    expect(h.sent('rebalance-decline')).toEqual([{ action: 'rebalance-decline', sessionId: 's3' }]);
    expect(takeSessionRebalance('s3')).toBeUndefined();
    // 任务所在电脑是旧版本、没记住关掉：下次预先问到时本机也先不显示。
    await act(async () => { await prefetchSessionRebalance('s3'); });
    expect(result.current).toBeNull();
  });

  it('sends at once without switching when nothing usable was fetched beforehand', async () => {
    // 还在问(慢)：不等它。
    setup(() => new Promise(() => undefined));
    void prefetchSessionRebalance('s4');
    expect(takeSessionRebalance('s4')).toBeUndefined();

    // 旧版本不认识这个请求。
    setup(() => Promise.reject(new Error('[INVALID_PARAMS] unknown provider group action')));
    await prefetchSessionRebalance('s5');
    expect(takeSessionRebalance('s5')).toBeUndefined();

    // 问好的提议已经过期(配额快照只在这么久内有效)，点过「切换」也不用。
    vi.useFakeTimers();
    try {
      const stale = setup(async () => suggestion('ask'));
      await prefetchSessionRebalance('s6');
      armSessionRebalance('s6', undefined, true);
      vi.advanceTimersByTime(SESSION_REBALANCE_CACHE_MS + 1);
      expect(takeSessionRebalance('s6')).toBeUndefined();
      expect(stale.sent('rebalance-decision')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

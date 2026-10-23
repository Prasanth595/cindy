/**
 * 手机换号轻提示(provider-groups.md §6.2「任务进行中换号」)：任务所在电脑提议换号时，输入框上方放一行「切换」/ ×
 * 的提示，不弹窗。不点切换就照常用当前账号发；点了切换，下一条消息发送前才把换号记到任务所在电脑；点 × 让它在配额
 * 重置前别再提议。组设为自动均衡(auto)时不显示提示，发送时直接记下。提议在任务空闲时预先问好，点发送时没有问好的
 * 提议(问不到、回包不对、还没问完)就立即照常发送，不多等一次往返。
 * 从发送前调用的入口验证用户看到什么、任务所在电脑收到什么。
 */
import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import {
  armMobileSessionRebalance,
  describeMobileRebalanceHint,
  dismissMobileSessionRebalance,
  offerMobileSessionRebalance,
  prefetchMobileSessionRebalance,
  readMobileSessionRebalanceHint,
} from '@/session/sessionRebalancePrompt';

const MINI = 'device:mini:anthropic';
const reply = (kind: 'ask' | 'auto') => ({
  kind,
  memberKey: MINI,
  label: 'Mini',
  quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 7 * 86_400_000 },
});

function invoker(suggestion: unknown, decline: 'ok' | 'old-host' = 'ok') {
  return vi.fn((_deviceId: string, _channel: string, args?: unknown[]): Promise<unknown> => {
    const request = args?.[0] as { action: string };
    if (request.action === 'rebalance-decline' && decline === 'old-host') {
      return Promise.reject(new Error('[INVALID_PARAMS] unknown provider group action'));
    }
    if (request.action !== 'rebalance-suggestion') return Promise.resolve({ ok: true });
    if (suggestion === 'pending') return new Promise(() => undefined);
    return suggestion instanceof Error ? Promise.reject(suggestion) : Promise.resolve(suggestion);
  });
}

const requests = (invoke: ReturnType<typeof invoker>, action: string) =>
  invoke.mock.calls.map(([, , args]) => args?.[0] as { action: string }).filter((r) => r.action === action);

async function offer(invoke: ReturnType<typeof invoker>, sessionId: string) {
  await offerMobileSessionRebalance({ invoke, hostDeviceId: 'pc', sessionId, clientId: 'message-a' });
}

describe('mobile rebalance hint', () => {
  it('shows a hint and sends on the current account when the user does nothing', async () => {
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'idle');

    expect(invoke).toHaveBeenCalledWith('pc', PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'rebalance-suggestion', sessionId: 'idle' }]);
    const hint = readMobileSessionRebalanceHint('pc', 'idle');
    expect(hint).toMatchObject({ armed: false, suggestion: { label: 'Mini', memberKey: MINI } });
    expect(describeMobileRebalanceHint(hint!.suggestion, false)).toContain('Mini');

    await offer(invoke, 'idle');
    expect(requests(invoke, 'rebalance-decision')).toEqual([]);
    // 一次提议只管一条消息：发过就收起。
    expect(readMobileSessionRebalanceHint('pc', 'idle')).toBeNull();
  });

  it('records the switch for the next message after the user taps Switch, and undo cancels it', async () => {
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'armed');
    armMobileSessionRebalance('pc', 'armed', true);
    const hint = readMobileSessionRebalanceHint('pc', 'armed');
    expect(hint?.armed).toBe(true);
    expect(describeMobileRebalanceHint(hint!.suggestion, true)).toContain('Mini');

    armMobileSessionRebalance('pc', 'armed', false);
    expect(readMobileSessionRebalanceHint('pc', 'armed')?.armed).toBe(false);
    armMobileSessionRebalance('pc', 'armed', true);

    await offer(invoke, 'armed');
    expect(requests(invoke, 'rebalance-decision')).toEqual([
      { action: 'rebalance-decision', sessionId: 'armed', clientId: 'message-a', memberKey: MINI, remember: false },
    ]);
    expect(readMobileSessionRebalanceHint('pc', 'armed')).toBeNull();
    await offer(invoke, 'armed');
    expect(requests(invoke, 'rebalance-decision')).toHaveLength(1);
  });

  it('keeps Switch across a refresh that suggests the same account', async () => {
    const invoke = invoker(reply('ask'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'refresh');
    armMobileSessionRebalance('pc', 'refresh', true);
    await prefetchMobileSessionRebalance(invoke, 'pc', 'refresh');
    expect(readMobileSessionRebalanceHint('pc', 'refresh')?.armed).toBe(true);
  });

  it.each(['ok', 'old-host'] as const)('dismiss hides the hint and tells the task’s computer (%s)', async (host) => {
    const sessionId = `dismiss-${host}`;
    const invoke = invoker(reply('ask'), host);
    await prefetchMobileSessionRebalance(invoke, 'pc', sessionId);
    dismissMobileSessionRebalance(invoke, 'pc', sessionId);

    expect(readMobileSessionRebalanceHint('pc', sessionId)).toBeNull();
    expect(requests(invoke, 'rebalance-decline')).toEqual([{ action: 'rebalance-decline', sessionId }]);
    // 旧版本电脑不认 decline、下一次预取仍回同一个提议时，也不再显示。
    await prefetchMobileSessionRebalance(invoke, 'pc', sessionId);
    expect(readMobileSessionRebalanceHint('pc', sessionId)).toBeNull();
    await offer(invoke, sessionId);
    expect(requests(invoke, 'rebalance-decision')).toEqual([]);
  });

  it('switches without a hint for a group or task set to switch automatically', async () => {
    const invoke = invoker(reply('auto'));
    await prefetchMobileSessionRebalance(invoke, 'pc', 'auto');
    expect(readMobileSessionRebalanceHint('pc', 'auto')).toBeNull();
    await offer(invoke, 'auto');
    expect(requests(invoke, 'rebalance-decision')).toEqual([
      { action: 'rebalance-decision', sessionId: 'auto', clientId: 'message-a', memberKey: MINI, remember: false },
    ]);
  });

  // Unit/protocol: combining two valid names used to silently discard the complete suggestion.
  it('offers a combined computer and account name at the protocol limit', async () => {
    const label = `${'D'.repeat(128)} · ${'A'.repeat(128)}`;
    const invoke = invoker({ ...reply('ask'), label });
    await prefetchMobileSessionRebalance(invoke, 'pc', 'long-name');
    expect(readMobileSessionRebalanceHint('pc', 'long-name')?.suggestion.label).toBe(label);
    armMobileSessionRebalance('pc', 'long-name', true);
    await offer(invoke, 'long-name');
    expect(requests(invoke, 'rebalance-decision')).toHaveLength(1);
  });

  it.each([
    ['an older computer that does not know the request', new Error('[INVALID_PARAMS] unknown action')],
    ['no suggestion', null],
    ['a malformed reply', { ...reply('ask'), label: '' }],
    ['a question still on its way', 'pending'],
  ])('shows nothing and sends at once for %s', async (name, suggestion) => {
    const invoke = invoker(suggestion);
    const fetched = prefetchMobileSessionRebalance(invoke, 'pc', name);
    if (suggestion !== 'pending') await fetched;
    expect(readMobileSessionRebalanceHint('pc', name)).toBeNull();
    await offer(invoke, name);
    expect(requests(invoke, 'rebalance-decision')).toEqual([]);
  });
});

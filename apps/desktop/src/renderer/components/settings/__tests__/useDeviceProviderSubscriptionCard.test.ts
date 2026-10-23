// @vitest-environment jsdom
/**
 * 一个供应商连接的订阅额度卡按「哪台电脑 + 哪个供应商」读(供应商组展开看每台的额度用)：
 *   - deviceId 为 null 读本机账号，不读任何远端镜像；
 *   - 指定电脑时经 device-link 查询那台的额度，按那台的供应商 id 读，不借用本机同名账号；
 *   - 不是订阅类连接(API key 等)两边都不读。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';
import { InvokeScheduler } from '../../../../../../../packages/device-link/src/invokeScheduler';
import { resolveInvokePriority } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  localClaude: [] as Array<[boolean, string]>,
  remoteClaude: [] as Array<[string | null, string | undefined]>,
  remoteCodex: [] as Array<[string | null, string | undefined]>,
  remoteXai: [] as Array<[string | null, string | undefined]>,
  invoke: vi.fn(),
  readLocal: vi.fn(),
  reopened: new Set<(event: { deviceId: string }) => void>(),
  codexUsage: null as Record<string, unknown> | null,
}));

const snapshot = (fiveHour: number) => ({
  fiveHour: { utilization: fiveHour, resetsAt: null },
  sevenDay: { utilization: 26, resetsAt: null },
  updatedAt: 1,
});

vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  useClaudeSubscriptionUsage: (enabled: boolean, providerId: string) => {
    mocks.localClaude.push([enabled, providerId]);
    return enabled ? snapshot(10) : null;
  },
}));
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useAccountUsage')>(),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: () => null,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
    mocks.remoteClaude.push([deviceId, providerId]);
    return deviceId ? snapshot(13) : null;
  },
}));
vi.mock('@/hooks/useRemoteDeviceUsage', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRemoteDeviceUsage')>('@/hooks/useRemoteDeviceUsage');
  return {
    ...actual,
    selectRemoteCodexAccountUsage: actual.selectRemoteCodexAccountUsage,
    useRemoteCodexAccountUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteCodex.push([deviceId, providerId]);
      return actual.useRemoteCodexAccountUsage(deviceId, providerId) ?? (deviceId ? mocks.codexUsage : null);
    },
    useRemoteXaiSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteXai.push([deviceId, providerId]);
      return null;
    },
  };
});

import { useDeviceProviderSubscriptionCard } from '../useProviderSubscriptionCard';
import { resetRemoteDeviceUsageMirrorsForTest } from '@/hooks/useRemoteDeviceUsage';

function provider(id: string, auth: Record<string, unknown>): ProviderView {
  return { id, name: id, source: 'user', connected: true, auth } as unknown as ProviderView;
}
const claude = provider('anthropic-1a2b', { method: 'oauth', native: 'claude' });
const apiKey = provider('openrouter', { method: 'api-key' });

beforeEach(() => {
  vi.useFakeTimers();
  setDataOwnerGeneration('quota-owner');
  resetRemoteDeviceUsageMirrorsForTest();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  mocks.invoke.mockReset();
  mocks.readLocal.mockReset();
  mocks.reopened.clear();
  mocks.codexUsage = null;
  vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: mocks.readLocal } }, deviceLink: {
    invoke: mocks.invoke,
    onRemotePush: () => () => {},
    onPresenceChanged: () => () => {},
    onStatusChanged: () => () => {},
    onPeerLinkReopened: (listener: (event: { deviceId: string }) => void) => {
      mocks.reopened.add(listener);
      return () => mocks.reopened.delete(listener);
    },
  } });
  mocks.localClaude.length = 0;
  mocks.remoteClaude.length = 0;
  mocks.remoteCodex.length = 0;
  mocks.remoteXai.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const remaining = (card: ReturnType<typeof useDeviceProviderSubscriptionCard>) =>
  card?.windows.map((window) => [window.key, window.window.utilization]);

describe('useDeviceProviderSubscriptionCard', () => {
  // Unit regression r4355497194 / remote-and-mobile-adaptation.md: six expanded
  // accounts produce twelve slow periodic reads. Existing polling coverage had
  // only one account. Run the real admission scheduler at the preload boundary:
  // at most four automatic reads may start, and opening another card must work
  // immediately without waiting for any of those reads to finish.
  it('keeps periodic quota reads in background slots so opening another account is responsive', async () => {
    const scheduler = new InvokeScheduler();
    const accounts = Array.from({ length: 6 }, (_, index) =>
      provider(`openai-${index}`, { method: 'oauth', native: 'codex' }));
    const automaticIds = new Set(accounts.map(account => account.id));
    const releases: Array<() => void> = [];
    let polling = false;
    let started = 0;
    mocks.invoke.mockImplementation((deviceId, channel, args, scheduling?: { background?: boolean }) =>
      scheduler.run(deviceId, resolveInvokePriority(channel, scheduling?.background), 30_000, async () => {
        const providerId = args[channel === 'maker:usage:account' ? 1 : 0];
        if (polling && automaticIds.has(providerId)) {
          started++;
          await new Promise<void>(resolve => releases.push(resolve));
        }
        const quota = { primary: { usedPercent: 91, windowMinutes: 300 } };
        return channel === 'maker:usage:account' ? { providerId, ...quota }
          : { providerId, account: { planType: 'plus' }, rateLimits: quota };
      }));
    for (const account of accounts) {
      renderHook(() => useDeviceProviderSubscriptionCard(account, 'mini', { live: true }));
    }
    await act(async () => {});
    polling = true;
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(started).toBe(4);
    const opened = renderHook(() => useDeviceProviderSubscriptionCard(
      provider('openai-opened', { method: 'oauth', native: 'codex' }), 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(opened.result.current)).toEqual([['primary', 91]]);
    polling = false;
    await act(async () => { releases.forEach(resolve => resolve()); });
  });

  // Unit regression (provider-groups.md §10): the remote card used only a stale mirror.
  // Existing cases cover account location, not native RPC results or visible-card refreshes.
  // Minimal input: mirror says 50%, native account says 73%, with no usage push/local panel.
  // Single-file command wall time: 3.96s (2026-10-22).
  it('shows native quota on opening, polls only while visible, and refreshes on return/reconnect', async () => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    const native = (usedPercent: number) => ({
      providerId: openai.id,
      account: { planType: 'plus', email: null, accountId: null },
      // A model-specific latest bucket must not replace the generic account quota.
      rateLimits: { primary: { usedPercent: 99 }, limitId: 'spark' },
      rateLimitsByLimitId: { codex: { primary: { usedPercent, windowMinutes: 300 } } },
    });
    mocks.codexUsage = { primary: { usedPercent: 50, windowMinutes: 300 } };
    let nativeReads = 0;
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(nativeReads++ === 0 ? 73 : 84));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', ['openai-extra']);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 84]]);
    const readsBeforeHiding = mocks.invoke.mock.calls.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeHiding);

    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(91));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
    const readsBeforeReconnect = mocks.invoke.mock.calls.length;
    act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'other' })));
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeReconnect);
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(96));
    await act(async () => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    expect(remaining(hook.result.current)).toEqual([['primary', 96]]);
    hook.unmount();
    const readsBeforeClosing = mocks.invoke.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeClosing);
    expect(mocks.reopened.size).toBe(0);
  });

  it('keeps the matching account mirror when an older computer cannot query native quota', async () => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    mocks.codexUsage = { primary: { usedPercent: 50, windowMinutes: 300 } };
    mocks.invoke.mockRejectedValue(new Error('[CHANNEL_NOT_ALLOWED] old computer'));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini'));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 50]]);
  });

  // Unit regression: PR #6752 r4355398578. Recovery coverage only kept an old
  // request pending. With no old request, the mount already starts a fresh read;
  // queuing another read can clear its successful native quota on a second error.
  // Minimal input: 73% before hiding/offline, then native 91%, with any duplicate
  // native request failing. The real card must keep 91% with one recovery read.
  it.each(['foreground', 'member-online'] as const)('keeps fresh native quota after one %s recovery read', async (resume) => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    let nativeReads = 0;
    mocks.invoke.mockImplementation(async (_deviceId, channel) => {
      const quota = { primary: { usedPercent: 50, windowMinutes: 300 } };
      if (channel === 'maker:usage:account') return { providerId: openai.id, ...quota };
      if (++nativeReads > 2) throw new Error('duplicate recovery read failed');
      return {
        providerId: openai.id,
        account: { planType: 'plus' },
        rateLimits: { primary: { usedPercent: nativeReads === 1 ? 73 : 91, windowMinutes: 300 } },
      };
    });
    const hook = renderHook(({ selected, deviceId }: { selected: ProviderView | undefined; deviceId: string | null }) =>
      useDeviceProviderSubscriptionCard(selected, deviceId, { live: true }),
    { initialProps: { selected: openai as ProviderView | undefined, deviceId: 'mini' as string | null } });
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    } else {
      hook.rerender({ selected: undefined, deviceId: null });
      hook.rerender({ selected: openai, deviceId: 'mini' });
      await act(async () => {});
    }
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
    expect(nativeReads).toBe(2);
    expect(mocks.invoke.mock.calls.filter(([, channel]) => channel === 'maker:usage:account')).toHaveLength(2);
  });

  // Unit regression: PR #6752 review r4344705884. Existing reconnect coverage used
  // a completed/mocked mirror. r4344881854 adds foreground/member-online recovery:
  // those paths temporarily unmount the epoch listener, so they must also queue
  // one read behind the old pending request. No timer advance is needed for 82%.
  it.each([
    { resume: 'reconnect', native: false },
    { resume: 'foreground', native: true },
    { resume: 'member-online', native: false },
    { resume: 'reopen', native: true },
  ] as const)('queues one recovery read on $resume when the old request is still pending', async ({ resume, native }) => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    const quotaChannel = native ? 'maker:usage:codex-rate-limits' : 'maker:usage:account';
    let rejectOld!: (error: Error) => void;
    let reads = 0;
    mocks.invoke.mockImplementation((_deviceId, channel) => {
      if (channel !== quotaChannel) return native ? Promise.resolve(null)
        : Promise.reject(new Error('[CHANNEL_NOT_ALLOWED] old computer'));
      if (reads++ === 0) return new Promise((_resolve, reject) => { rejectOld = reject; });
      const quota = { primary: { usedPercent: 82, windowMinutes: 300 } };
      return Promise.resolve(native ? { providerId: openai.id, account: { planType: 'plus' }, rateLimits: quota }
        : { providerId: openai.id, ...quota });
    });
    const renderCard = () => renderHook(({ selected, deviceId }: { selected: ProviderView | undefined; deviceId: string | null }) =>
      useDeviceProviderSubscriptionCard(selected, deviceId, { live: true }),
    { initialProps: { selected: openai as ProviderView | undefined, deviceId: 'mini' as string | null } });
    let hook = renderCard();
    await act(async () => {});
    expect(remaining(hook.result.current)).toBeUndefined();
    expect(reads).toBe(1);
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (resume === 'member-online') hook.rerender({ selected: undefined, deviceId: null });
    else if (resume === 'reopen') hook.unmount();
    if (resume !== 'reconnect') expect(mocks.reopened.size).toBe(0);
    act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (resume === 'member-online') hook.rerender({ selected: openai, deviceId: 'mini' });
    else if (resume === 'reopen') hook = renderCard();
    await act(async () => rejectOld(new Error('old link disconnected')));
    expect(remaining(hook.result.current)).toEqual([['primary', 82]]);
    expect(reads).toBe(2);
  });

  // Unit regression: PR #6752 r4344811616. A native snapshot can outlive a missed
  // account-switch clear. Existing cases start without a cached native snapshot.
  // A fresh B mirror must replace A after the native reread fails, on either
  // remount or link reopen; a later successful native read must become primary.
  it.each(['remount', 'reconnect'] as const)('discards stale native quota after a missed account clear and failed %s read', async (mode) => {
    const openai = provider('openai-switched', { method: 'oauth', native: 'codex' });
    const native = (accountId: string, usedPercent: number) => ({
      providerId: openai.id, account: { accountId, planType: 'plus' },
      rateLimits: { primary: { usedPercent, windowMinutes: 300 } },
    });
    const account = (accountId: string, usedPercent: number) => ({
      providerId: openai.id, accountId, primary: { usedPercent, windowMinutes: 300 },
    });
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? account('account-a', 50) : native('account-a', 73));
    let hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    if (mode === 'remount') hook.unmount();
    mocks.invoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:usage:account') return account('account-b', 82);
      throw new Error('native quota temporarily unavailable');
    });
    if (mode === 'remount') hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    else act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 82]]);
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? account('account-b', 82) : native('account-b', 91));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
  });

  // Unit regression r4362108215 / provider-groups.md §10: remote recovery tests
  // did not cover the local native hook. Hide/resume during its first pending
  // read, then fail the queued reread: the first successful quota must remain.
  it('keeps a pending local quota result across foreground resume and queues one reread', async () => {
    const openai = provider('openai', { method: 'oauth', native: 'codex' });
    const native = { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 73, windowMinutes: 300 } } };
    let resolveFirst!: (value: typeof native) => void;
    let rejectNext!: (error: Error) => void;
    mocks.readLocal.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectNext = reject; }));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, null, { live: true }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.readLocal).toHaveBeenCalledTimes(1);
    await act(async () => resolveFirst(native));
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.readLocal).toHaveBeenCalledTimes(2);
    await act(async () => rejectNext(new Error('quota temporarily unavailable')));
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refreshes the local account on the same live-card interval without querying another computer', async () => {
    const openai = provider('openai', { method: 'oauth', native: 'codex' });
    const native = (usedPercent: number) => ({
      account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } },
    });
    mocks.readLocal.mockResolvedValueOnce(native(55)).mockResolvedValue(native(76));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, null, { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 55]]);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 76]]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('reads this computer’s account when no device is given', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, null));
    expect(remaining(result.current)).toEqual([['five-hour', 10], ['seven-day', 26]]);
    expect(mocks.localClaude.at(-1)).toEqual([true, 'anthropic-1a2b']);
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads the other computer’s account by its own provider id, never this computer’s', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, 'mini'));
    expect(remaining(result.current)).toEqual([['five-hour', 13], ['seven-day', 26]]);
    expect(mocks.remoteClaude.at(-1)).toEqual(['mini', 'anthropic-1a2b']);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
    expect(mocks.remoteCodex.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.remoteXai.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads nothing for a connection without a subscription quota', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(apiKey, 'mini'));
    expect(result.current).toBeNull();
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
  });
});

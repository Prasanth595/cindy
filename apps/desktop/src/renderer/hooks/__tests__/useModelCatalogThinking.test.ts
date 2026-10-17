// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelCatalogThinking } from '../useModelCatalogThinking';

const get = vi.fn();
const set = vi.fn();
const ownerState = { current: true };
let subscriptions = 0;
let unsubscribes = 0;
let broadcast: (() => void) | undefined;

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
  isDataOwnerGenerationCurrent: () => ownerState.current,
}));

beforeEach(() => {
  vi.clearAllMocks();
  ownerState.current = true;
  subscriptions = 0;
  unsubscribes = 0;
  broadcast = undefined;
  Object.assign(window, {
    electronAPI: {
      maker: {
        getModelCatalogThinking: get,
        setModelCatalogThinking: set,
        onProvidersChanged: (callback: () => void) => {
          subscriptions += 1;
          broadcast = callback;
          return () => {
            unsubscribes += 1;
          };
        },
      },
    },
  });
});

const target = { agent: 'pi' as const, providerId: 'p', modelId: 'm' };
type Props = { target: typeof target | null };

describe('model catalog thinking override hook', () => {
  it('returns the cleanup on the empty-target cycle too, so open/close cycles do not leak subscriptions', async () => {
    // 回归（greptile P2）：抽屉关闭（target=null）的 effect 周期先前只订阅、直接 return，
    // 不交还清理函数 —— 每开关一次抽屉泄漏一个 onProvidersChanged 订阅。泄漏回调在之后的
    // 保存广播里调 run()：setState(EMPTY) 清掉勾选、递增 generation 顶掉写入回声，补读前
    // 界面错误显示「跟随供应商」。
    get.mockResolvedValue({ tiers: ['low'], defaultEffort: 'low', isCustomized: false });
    const hook = renderHook((props: Props) => useModelCatalogThinking(props.target), {
      initialProps: { target } as Props,
    });
    await act(async () => {});
    expect(subscriptions).toBe(1);

    // 开 → 关 → 再开：每个 effect 周期留下的订阅都必须在其清理函数里注销。
    hook.rerender({ target: null });
    await act(async () => {});
    hook.rerender({ target });
    await act(async () => {});
    expect(subscriptions).toBe(3);
    expect(unsubscribes).toBe(2); // 前两个周期已注销；泄漏时这里是 1

    hook.unmount();
    expect(unsubscribes).toBe(subscriptions); // 卸载后一个不剩
  });

  it('a broadcast after reopen reads through exactly once instead of being clobbered by a stale callback', async () => {
    // 泄漏的可观察后果：重开后的广播会同时触发泄漏回调（空目标 → setState(EMPTY)）与当前
    // 回调（真读回），EMPTY 后到还会把读回值盖掉。修复后每个周期只有一份订阅，广播恰好
    // 触发一次 GET，界面停在真值上。
    get.mockResolvedValue({ tiers: ['low'], defaultEffort: 'low', isCustomized: false });
    const hook = renderHook((props: Props) => useModelCatalogThinking(props.target), {
      initialProps: { target } as Props,
    });
    await act(async () => {});
    hook.rerender({ target: null });
    await act(async () => {});
    hook.rerender({ target });
    await act(async () => {});
    get.mockClear();

    await act(async () => {
      broadcast?.();
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toMatchObject({ tiers: ['low'], loading: false, error: false });
  });
});

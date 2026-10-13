// @vitest-environment jsdom
/**
 * 收藏另一台电脑上的模型(远程 Agent),用起来与本机收藏一样(model-selector-unified §1.5「远程收藏按
 * 被控电脑共享」):
 *   1. 浏览那台电脑的目录时点 ☆:写进任务所在电脑那一份收藏(运行位置编进 providerId),不读写那台
 *      电脑自己的收藏;
 *   2. 回到任务所在电脑的目录,收藏区照样列出它,来源名带那台电脑;选中 = 在那台电脑上运行;
 *   3. 那台的目录读不到时置灰列出;目录里已没有这个模型时不显示,收藏保留;
 *   4. 被控电脑上的任务:收藏读写被控电脑那一份(经设备互联)。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentDeviceFavoriteSource,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_GET,
  type ModelFavoriteMutation,
  type RemoteModelFavorite,
} from '@cindy/device-link';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.addFavorite': '收藏',
        'newChat.modelSelector.unified.removeFavorite': '取消收藏',
        'newChat.modelSelector.unified.customize': '自定义',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${options?.provider ?? ''} · ${options?.device ?? ''}`,
        'newChat.modelSelector.unified.remoteFavoriteUnavailable': `${options?.source ?? ''} · 读不到`,
        'effortLevels.low': '低',
        'effortLevels.high': '高',
      };
      return table[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: false, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

const catalogs = vi.hoisted(() => {
  const provider = (
    id: string,
    name: string,
    models: readonly (readonly [string, string])[],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'api-key' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': models.map(([modelId, modelName]) => ({
        id: modelId,
        name: modelName,
        contextWindow: 200000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      })),
    },
    ...extra,
  });
  return {
    offline: new Set<string>(),
    local: [provider('a-local', 'A Local', [['a-model', 'A Model']])] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', [['b-model', 'B Model']])],
      'device-c': [
        provider('c-open', 'C Open', [['c-model', 'C Model']], { remoteInvocationEnabled: true }),
      ],
    } as Record<string, unknown[]>,
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (deviceId?: string) =>
    deviceId && catalogs.offline.has(deviceId)
      ? { providers: [], loading: false, error: 'DEVICE_LINK_UNREACHABLE', unsupported: false }
      : {
          providers: deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
          loading: false,
          error: null,
          unsupported: false,
        },
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((deviceId) => [
        deviceId,
        catalogs.offline.has(deviceId)
          ? { providers: [], loading: false, error: 'DEVICE_LINK_UNREACHABLE' }
          : { providers: catalogs.byDevice[deviceId] ?? [], loading: false, error: null },
      ]),
    ),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import {
  __resetForTest as resetFavorites,
  addModelFavorite,
  listModelFavorites,
} from '@/state/modelFavorites';

const devices = [{ deviceId: 'device-c', name: 'Studio' }];
const C_SOURCE = agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'c-open' });

/** 设备互联:被控电脑 device-b 上的一份收藏(其他电脑的读写都记下来,应当一次都没有)。 */
let remoteLists: Record<string, RemoteModelFavorite[]>;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
  catalogs.offline.clear();
  remoteLists = { 'device-b': [] };
  let seq = 1;
  invoke = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
    const list = remoteLists[deviceId];
    if (!list) throw new Error('no favorites on this device');
    if (channel === MODEL_FAVORITES_GET) return list;
    if (channel === MODEL_FAVORITES_APPLY) {
      const mutation = args[0] as ModelFavoriteMutation;
      if (mutation.kind === 'add') list.push({ uid: `fav-${seq++}`, ...mutation.item });
      if (mutation.kind === 'remove')
        remoteLists[deviceId] = list.filter((item) => item.uid !== mutation.expected.uid);
      return remoteLists[deviceId];
    }
    throw new Error(`unexpected ${channel}`);
  });
  vi.stubGlobal('electronAPI', {
    deviceLink: {
      invoke,
      onRemotePush: () => () => {},
      onStatusChanged: () => () => {},
      onPeerLinkReset: () => () => {},
      onResponsivenessChanged: () => () => {},
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = () => screen.getByRole('listbox');
const favoritesGroup = () => within(list()).getByRole('group', { name: '收藏' });
const rowOf = (scope: HTMLElement, name: string) =>
  within(scope).getByText(name).closest('[data-unified-anchor]') as HTMLElement;

function renderPanel(
  remoteAgent: Partial<React.ComponentProps<typeof ModelSelectorContent>['remoteAgent']> = {},
  props: Partial<React.ComponentProps<typeof ModelSelectorContent>> = {},
) {
  const onUnifiedSelect = vi.fn(async () => true);
  const onRelocate = vi.fn(async () => true);
  const onProviderChange = vi.fn();
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange,
      vendorKey: 'cc',
      onUnifiedSelect,
      remoteAgent: { devices, selectedDeviceId: null, ...remoteAgent },
      ...props,
    }),
  );
  return { onUnifiedSelect, onRelocate, onProviderChange };
}

describe('本机任务:收藏另一台电脑上的模型', () => {
  it('浏览那台电脑时点 ☆ 写进本机收藏,不读写那台电脑自己的收藏', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    const row = rowOf(list(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '收藏' }));
    });
    expect(listModelFavorites()).toEqual([
      expect.objectContaining({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' }),
    ]);
    // 那台电脑的视图里照样列出这条收藏(还原成那台的真实 providerId)。
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
    expect(invoke.mock.calls.some(([deviceId]) => deviceId === 'device-c')).toBe(false);
  });

  it('回到本机目录:收藏区列出它并带上电脑名,选中 = 在那台电脑运行', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc', effort: 'low' });
    const uid = listModelFavorites()[0]!.uid;
    const { onUnifiedSelect, onProviderChange } = renderPanel();
    const row = rowOf(favoritesGroup(), 'C Model');
    expect(within(row).getByText('C Open · Studio')).toBeTruthy();
    // 配置在那台电脑的目录里调,这里不出配置浮层。
    expect(within(row).queryByRole('button', { name: '自定义' })).toBeNull();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        engine: 'cc',
        effort: 'low',
        favoriteUid: uid,
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('在本机目录里取消这条收藏', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    renderPanel();
    const row = rowOf(favoritesGroup(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '取消收藏' }));
    });
    expect(listModelFavorites()).toEqual([]);
  });

  it('已建任务:Agent 在本机时选中它 = 连运行位置一起换到那台电脑', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    const onRelocate = vi.fn(async () => true);
    const { onProviderChange } = renderPanel(
      { onRelocate },
      { actualRoute: true, onUnifiedSelect: undefined },
    );
    await act(async () => {
      fireEvent.click(rowOf(favoritesGroup(), 'C Model'));
    });
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        agent: 'claude-code',
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('已建任务:Agent 已在那台电脑时切到那台的目录,由那里的会话链路选', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    const onRelocate = vi.fn(async () => true);
    renderPanel(
      { onRelocate, selectedDeviceId: 'device-c' },
      {
        actualRoute: true,
        onUnifiedSelect: undefined,
        modelId: 'c-model',
        currentProviderId: 'c-open',
      },
    );
    // 打开时停在那台的目录;切回本机目录(「全部」视图,按本机供应商筛的格不列其他电脑的收藏)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    await act(async () => {
      fireEvent.click(rowOf(favoritesGroup(), 'C Model'));
    });
    expect(onRelocate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'C Open · Studio' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
  });

  it('那台的目录读不到:置灰列出;目录里已没有这个模型:不显示,收藏保留', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    addModelFavorite({
      providerId: agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'c-open' }),
      modelId: 'gone-model',
      agent: 'cc',
    });
    catalogs.offline.add('device-c');
    const { onUnifiedSelect } = renderPanel();
    const row = rowOf(favoritesGroup(), 'c-model');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(within(row).getByText('c-open · Studio · 读不到')).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    cleanup();

    catalogs.offline.clear();
    renderPanel();
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
    expect(within(list()).queryByText('gone-model')).toBeNull();
    expect(listModelFavorites()).toHaveLength(2);
  });
});

describe('被控电脑上的任务:收藏读写被控电脑那一份', () => {
  it('浏览第三台电脑时点 ☆ 经设备互联写进被控电脑的收藏,回到被控电脑目录照样列出', async () => {
    renderPanel(
      { homeDeviceId: 'device-b' },
      { deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main' },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    const row = rowOf(list(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '收藏' }));
    });
    expect(invoke).toHaveBeenCalledWith('device-b', MODEL_FAVORITES_APPLY, [
      {
        kind: 'add',
        item: expect.objectContaining({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' }),
      },
    ]);
    expect(invoke.mock.calls.some(([deviceId]) => deviceId === 'device-c')).toBe(false);
    // 本机自己的收藏不动。
    expect(listModelFavorites()).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
  });

  it('远程控制(不经远程 Agent)照旧读被控电脑自己的收藏', async () => {
    remoteLists['device-b'] = [
      { uid: 'fav-9', providerId: 'b-main', modelId: 'b-model', agent: 'cc' },
    ];
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'b-model',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'b-main',
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        deviceId: 'device-b',
      }),
    );
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('device-b', MODEL_FAVORITES_GET, []);
    expect(within(favoritesGroup()).getByText('B Model')).toBeTruthy();
  });
});

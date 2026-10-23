// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDeviceLinkSettings } from '../useDeviceLinkSettings';

const translate = vi.hoisted(() => (key: string) => key);
const effects = vi.hoisted(() => ({ removeDevice: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { removeDevice: effects.removeDevice } }));
vi.mock('@/lib/toast', () => ({ toast: { success: effects.success, error: effects.error } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

describe('useDeviceLinkSettings ownership state', () => {
  it('keeps a newer ownership push when the initial getState snapshot resolves late', async () => {
    type State = Awaited<ReturnType<typeof window.electronAPI.deviceLink.getState>>;
    const state = deferred<State>();
    let controlledChanged:
      ((payload: { controllers: { deviceId: string; name: string }[] }) => void) | undefined;
    let ownershipChanged: ((payload: { standby: boolean }) => void) | undefined;
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const api = {
      getState: vi.fn(() => state.promise),
      listDevices: vi.fn(async () => ({ devices: [] })),
      onOwnershipChanged: vi.fn((callback: (payload: { standby: boolean }) => void) => {
        ownershipChanged = callback;
        return off;
      }),
      onPresenceChanged: subscribe,
      onStatusChanged: subscribe,
      onConnectionIssue: subscribe,
      onControlledState: vi.fn((callback: typeof controlledChanged) => {
        controlledChanged = callback;
        return off;
      }),
      onControlTargetChanged: subscribe,
    };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = {
      deviceLink: api,
    };

    const { result, unmount } = renderHook(() => useDeviceLinkSettings());

    expect(api.onOwnershipChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.getState.mock.invocationCallOrder[0],
    );
    act(() => ownershipChanged?.({ standby: true }));
    expect(result.current.standby).toBe(true);
    act(() => controlledChanged?.({ controllers: [{ deviceId: 'mac', name: 'MacBook' }] }));

    await act(async () => {
      state.resolve({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [
          { deviceId: 'mac', name: 'MacBook' },
          { deviceId: 'phone', name: 'Phone' },
        ],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      });
      await state.promise;
    });

    expect(result.current.standby).toBe(true);
    expect(result.current.controlledBy).toEqual([{ deviceId: 'mac', name: 'MacBook' }]);
    unmount();
  });
});


describe('useDeviceLinkSettings deletion', () => {
  it.each(['refused', 'wrong-device', 'error', 'deleted'] as const)('clears cached remote sessions only on confirmed success: %s', async outcome => {
    const deleteDevice = outcome === 'error' ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({ deviceId: outcome === 'wrong-device' ? 'other' : 'target', deleted: outcome !== 'refused' });
    const api = { deleteDevice };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = { deviceLink: api };
    const { result, unmount } = renderHook(() => useDeviceLinkSettings(false));
    let deleted = false;
    await act(async () => { deleted = await result.current.remove('target'); });
    expect(deleted).toBe(outcome === 'deleted');
    if (deleted) {
      expect(effects.removeDevice).toHaveBeenCalledWith('target');
      expect(effects.success).toHaveBeenCalledWith('settings.devices.toast.deleted');
    } else {
      expect(effects.removeDevice).not.toHaveBeenCalled();
      expect(effects.error).toHaveBeenCalledWith('settings.devices.toast.deleteFailed');
    }
    unmount();
  });

  // 服务端以「在线」拒绝删除(409 → ALREADY_EXISTS)时，先刷新列表再选提示，提示要跟此刻
  // 界面上的列表一致：仍显示离线的设备不能再提示「尚不支持移除在线设备」；点删除时与刷新后
  // 状态不同，以刷新后的为准。刷新一直不返回时界面仍是原列表，按原列表选提示；刷新失败时
  // 界面换成错误块，沿用原提示。没有截止时间的请求也不能让删除一直不返回。
  it.each([
    [false, 'offline', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [true, 'online', 'settings.devices.toast.deleteOnline'],
    [false, 'online', 'settings.devices.toast.deleteOnline'],
    [true, 'offline', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [false, 'fails', 'settings.devices.toast.deleteOnline'],
    [false, 'never returns', 'settings.devices.toast.deleteRejectedWhileOffline'],
    [true, 'never returns', 'settings.devices.toast.deleteOnline'],
  ] as const)('explains an online rejection by the refreshed list (online before: %s, refresh: %s)', async (onlineBefore, refreshed, message) => {
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const listed = (online: boolean) => ({
      devices: [{ deviceId: 'target', name: 'MacBook', platform: 'darwin', appVersion: null, lastSeenAt: null,
        online, busy: false, remoteControlEnabled: false, controlEnabled: true, isSelf: false }],
    });
    const listDevices = vi.fn().mockResolvedValueOnce(listed(onlineBefore));
    if (refreshed === 'fails') listDevices.mockRejectedValue(new Error('[INTERNAL] list failed'));
    else if (refreshed === 'never returns') listDevices.mockReturnValue(new Promise<never>(() => {}));
    else listDevices.mockResolvedValue(listed(refreshed === 'online'));
    const api = {
      getState: vi.fn(() => new Promise<never>(() => {})),
      listDevices,
      deleteDevice: vi.fn().mockRejectedValue(new Error('[ALREADY_EXISTS] device is online')),
      onOwnershipChanged: subscribe,
      onPresenceChanged: subscribe,
      onStatusChanged: subscribe,
      onConnectionIssue: subscribe,
      onControlledState: subscribe,
      onControlTargetChanged: subscribe,
    };
    (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = { deviceLink: api };
    const { result, unmount } = renderHook(() => useDeviceLinkSettings());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    vi.useFakeTimers();
    try {
      let deleted: boolean | undefined;
      await act(async () => {
        const removing = result.current.remove('target').then((value) => { deleted = value; });
        // 「一直不返回」靠超时收口；其余情况不需要推进时间也已结束。
        await vi.advanceTimersByTimeAsync(60_000);
        await removing;
      });
      expect(deleted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(effects.error).toHaveBeenCalledWith(message);
    expect(effects.removeDevice).not.toHaveBeenCalled();
    expect(api.listDevices).toHaveBeenCalledTimes(2);
    unmount();
  });
});

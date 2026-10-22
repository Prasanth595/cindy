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

  // 服务端以「在线」拒绝删除(409 → ALREADY_EXISTS)时，提示要跟列表里看到的状态一致：
  // 列表显示离线的设备不能再提示「尚不支持移除在线设备」，并要刷新列表与服务端对齐。
  it.each([
    [false, 'settings.devices.toast.deleteRejectedWhileOffline'],
    [true, 'settings.devices.toast.deleteOnline'],
  ] as const)('explains an online rejection by the listed presence (listed online: %s)', async (online, message) => {
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const api = {
      getState: vi.fn(() => new Promise<never>(() => {})),
      listDevices: vi.fn(async () => ({
        devices: [{ deviceId: 'target', name: 'MacBook', platform: 'darwin', appVersion: null, lastSeenAt: null,
          online, busy: false, remoteControlEnabled: false, controlEnabled: true, isSelf: false }],
      })),
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

    let deleted = true;
    await act(async () => { deleted = await result.current.remove('target'); });

    expect(deleted).toBe(false);
    expect(effects.error).toHaveBeenCalledWith(message);
    expect(effects.removeDevice).not.toHaveBeenCalled();
    expect(api.listDevices).toHaveBeenCalledTimes(2);
    unmount();
  });
});

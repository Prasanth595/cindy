// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { TaskRemoteDesktopButton } from '../TaskRemoteDesktopButton';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => fixture.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const capabilities = {
  version: 1,
  enabled: true,
  canControl: true,
  platform: 'win32',
  displays: [{ id: 'screen', width: 1920, height: 1080 }],
};
const invoke = vi.fn();
const open = vi.fn();
const device = (): DeviceLinkDeviceView => ({
  deviceId: 'remote',
  name: 'Remote computer',
  platform: 'win32',
  appVersion: '1',
  lastSeenAt: null,
  online: true,
  busy: true,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
});

beforeEach(async () => {
  vi.clearAllMocks();
  revokedDevicesStore.clearAll();
  unresponsiveDevicesStore.clearAll();
  fixture.devices = [device()];
  invoke.mockReset().mockResolvedValue(capabilities);
  open.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, openRemoteDesktop: open } });
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  revokedDevicesStore.clearAll();
  unresponsiveDevicesStore.clearAll();
  vi.restoreAllMocks();
});

function unavailable() {
  const button = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(button.className).toContain('opacity-50');
  expect(button.querySelector('.lucide-monitor-off')).not.toBeNull();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(button.getAttribute('aria-label'), { duration: 8000 });
  return button;
}

it('checks the computer, then opens its remote desktop', async () => {
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  expect(action.getAttribute('aria-disabled')).toBe('true');
  await act(async () => {});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remote', REMOTE_DESKTOP_CHANNEL, [
    { op: 'capabilities' },
  ]);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  expect(action.className).not.toContain('opacity-50');
  fireEvent.click(action);
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'Remote computer' });
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
});

it.each([
  [{ online: false }, 'This computer is offline.'],
  [
    { remoteControlEnabled: false },
    i18n.getResource('en', 'common', 'remoteDesktop.remoteDisabled'),
  ],
  [
    { controlEnabled: false },
    i18n.getResource('en', 'common', 'remoteDesktop.shortcut.controlDisabled'),
  ],
] satisfies [Partial<DeviceLinkDeviceView>, string][])(
  'greys out with the reason, without probing, when the computer cannot be remoted now: %j',
  async (patch, reason) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(<TaskRemoteDesktopButton deviceId="remote" />);
    await act(async () => {});
    expect(unavailable().getAttribute('aria-label')).toContain(reason);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([[{ platform: 'ios' }], [{ isSelf: true }]] satisfies [Partial<DeviceLinkDeviceView>][])(
  'stays hidden for a device that is never a remote desktop target: %j',
  async (patch) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(<TaskRemoteDesktopButton deviceId="remote" />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([
  [{ ...capabilities, enabled: false }, 'remoteDesktop.disabled'],
  [
    { ...capabilities, permissions: { screenRecording: 'missing', accessibility: 'granted' } },
    'remoteDesktop.shortcut.screenRecordingRequired',
  ],
])('explains why the computer refuses remote desktop: %j', async (value, reasonKey) => {
  invoke.mockResolvedValue(value);
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t(reasonKey));
});

it('rechecks an interrupted check when the user looks at it again', async () => {
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms'));
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  const action = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(invoke).toHaveBeenCalledOnce();
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('does not recheck a definitive refusal on hover', async () => {
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  fireEvent.mouseEnter(screen.getByRole('button'));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
});

it('coalesces repeated clicks and keeps the button after a failed open', async () => {
  let reject!: (error: Error) => void;
  open.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  const action = screen.getByRole('button', { name: 'Open remote desktop' });
  fireEvent.click(action);
  expect(screen.getByRole('button', { name: 'Opening remote desktop…' })).toBe(action);
  fireEvent.click(action);
  expect(open).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('PERMISSION_DENIED')));
  expect(toast.error).toHaveBeenCalledWith(i18n.t('remoteDesktop.connectionError'));
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
});

it('uses the toolbar shape in the mac top bar and the chip shape in the Windows chip stack', async () => {
  const view = render(<TaskRemoteDesktopButton deviceId="remote" size="toolbar" />);
  expect(screen.getByRole('button').className).toContain('rounded-md');
  view.rerender(<TaskRemoteDesktopButton deviceId="remote" />);
  expect(screen.getByRole('button').className).toContain('rounded-full');
  await act(async () => {});
});

it('sits next to the right sidebar toggle on both platforms and skips shared-task peers', () => {
  const source = (path: string) =>
    readFileSync(resolve(__dirname, '../../../components/layout', path), 'utf8');
  const mainLayout = source('MainLayout.tsx');
  const contentHeader = source('ContentHeader.tsx');
  expect(mainLayout).toMatch(
    /deviceLinkDeviceId &&\s+!isSharedTaskPeer\(rightSidebarWorkdirInfo\.deviceLinkDeviceId\)/,
  );
  // mac:顶栏右端,紧挨右上角右栏开关的占位。
  expect(mainLayout).toMatch(/trailing=\{\s+isMac && remoteDesktopDeviceId \?/);
  expect(contentHeader).toMatch(/\{headerContent\}<\/div>\s+\{trailing\}/);
  // Windows:与右栏唤起 chip 同一个内容区浮动栈,先远程桌面、后唤起 chip。
  expect(mainLayout).toMatch(
    /data-testid="right-sidebar-fixed-trigger"[\s\S]{0,1200}<TaskRemoteDesktopButton[\s\S]{0,400}<RightSidebarToggle/,
  );
  // 按钮自身挖 no-drag 洞,mac 顶栏拖拽区里也能点。
  expect(readFileSync(resolve(__dirname, '../TaskRemoteDesktopButton.tsx'), 'utf8')).toMatch(
    /style=\{WINDOW_NO_DRAG_STYLE\}/,
  );
});

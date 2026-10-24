// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: 'owner:1:global', current: true, readDeviceList: vi.fn(),
  capabilities: vi.fn(), actors: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
vi.mock('@/chat/useChatServer', async () => {
  const { useMemo } = await import('react');
  return { useChatClient: () => useMemo(() => ({ owner: h.owner, enabled: true,
    current: () => h.current, client: { capabilities: h.capabilities, actors: h.actors } }), [h.owner]) };
});
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ readDeviceList: h.readDeviceList }) }));
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let result: ReturnType<typeof useCloudCompanionHome>;
function Probe() { result = useCloudCompanionHome(true); return null; }
const render = () => act(async () => root.render(createElement(Probe)));
const actor = { id: 'actor', kind: 'bot', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'studio' };
beforeEach(() => {
  vi.resetAllMocks(); h.owner = 'owner:1:global'; h.current = true;
  h.capabilities.mockResolvedValue({ companionHome: true }); h.actors.mockResolvedValue([actor]);
  h.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'studio', name: 'Mac Studio' }] });
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

// Tier: behavior. A successful actor refresh plus a failed optional directory read
// previously replaced a known computer name with its ID. Pure row tests miss this
// async failure path; drive the actual hook and its account fence.
it('retains known names on directory failure while accepting a changed home, without leaking across accounts', async () => {
  await render();
  expect(result.deviceNames.get('studio')).toBe('Mac Studio');
  h.readDeviceList.mockRejectedValue(new Error('directory unavailable'));
  h.actors.mockResolvedValue([{ ...actor, homeDeviceId: 'laptop' }]);
  await act(async () => result.refresh());
  expect(result.deviceNames.get('studio')).toBe('Mac Studio');
  expect(result.actors[0].homeDeviceId).toBe('laptop');
  h.owner = 'another:2:global';
  await render();
  expect(result.deviceNames.size).toBe(0);
  h.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'laptop', name: 'Renamed laptop' }] });
  await act(async () => result.refresh());
  expect([...result.deviceNames]).toEqual([['laptop', 'Renamed laptop']]);
});

it('ignores a late directory result after a newer refresh wins', async () => {
  await render();
  let complete!: (value: unknown) => void;
  h.readDeviceList.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = result.refresh(); });
  h.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'studio', name: 'New name' }] });
  await act(async () => result.refresh());
  await act(async () => { complete({ devices: [{ deviceId: 'studio', name: 'Old name' }] }); await pending; });
  expect(result.deviceNames.get('studio')).toBe('New name');
});

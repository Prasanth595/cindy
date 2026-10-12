// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generation: 1, enabled: true, revoked: new Set<string>(), online: true, syncing: false,
  targets: [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }],
  items: [] as any[], listeners: new Set<(id: string, payload: any) => void>(),
  invoke: vi.fn(), openLink: vi.fn(async () => {}), epoch: 1,
}));
vi.mock('react-native', () => ({ AppState: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => h.revoked }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  invoke: h.invoke, openLink: h.openLink, status: 'online', connectionEpoch: h.epoch,
  getPresenceAvailability: () => h.online,
  onRemoteResourceChanged: onChanged,
}) }));
function onChanged(listener: (id: string, payload: any) => void) { h.listeners.add(listener); return () => h.listeners.delete(listener); }
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ groupTargets: h.targets, loading: false, refresh: vi.fn() }) }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => ({
  items: h.items, syncing: h.syncing, isOnline: () => h.online, refresh: vi.fn(),
}) }));

import { useBotGroupSettingsManagement } from '@/session/useBotGroupSettingsManagement';

const host = { deviceId: 'mac', deviceName: 'Mac' };
const row = (id = 'g1', target = host) => ({ host: target, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: 'v1' } });
const resource = (role = 'owner', extra: Record<string, unknown> = {}) => ({
  ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: 'v1', display: { title: 'Group' }, links: [],
  blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '', data: {
    id: 'g1', name: 'Group', serverBacked: true, supportsSettingsManagement: true, revision: 4,
    members: [{ botId: 'bot', name: 'Bot', isOwned: true, role, status: 'active' }],
    messages: [], plans: [], round: { status: 'idle', speakers: [], canContinue: false }, ...extra,
  } }],
});
let root: Root | undefined;
let result: ReturnType<typeof useBotGroupSettingsManagement>;
function Probe() { result = useBotGroupSettingsManagement('g1', h.enabled); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
const reads = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:remote-resources:get');
const writes = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:remote-resources:invoke');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true; h.generation = 1; h.epoch = 1; h.online = true; h.syncing = false; h.revoked = new Set(); h.listeners.clear();
  h.items = [row()]; h.openLink.mockResolvedValue();
  h.invoke.mockImplementation(async (_id, channel) => channel === 'maker:remote-resources:get' ? resource() : { effects: [] });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('reads the exact room and sends settings only to its verified host with a revision', async () => {
  h.items = [row('other', h.targets[1]), row()];
  await render();
  expect(reads()).toHaveLength(1);
  expect(result.selected?.host.deviceId).toBe('mac');
  expect(result.reason).toBeNull();
  await act(async () => { await result.act('update', { name: 'New name' }); });
  expect(writes()[0]?.slice(0, 2)).toEqual(['mac', 'maker:remote-resources:invoke']);
  expect(writes()[0]?.[2][0]).toMatchObject({ actionId: 'update', resourceRef: { id: 'g1' }, input: { name: 'New name', expectedRevision: 4 } });
});

it.each(['member', 'guest'])('keeps %s read-only even on an online matching computer', async role => {
  h.invoke.mockResolvedValue(resource(role)); await render();
  expect(result.selected).toBeUndefined(); expect(result.reason).toBe('permission');
  await expect(result.act('update', { name: 'Denied' })).rejects.toThrow('PERMISSION_DENIED'); expect(writes()).toHaveLength(0);
});

it.each([{ supportsSettingsManagement: false }, { revision: undefined }, { archived: true }, { members: [{ botId: 'foreign', name: 'Foreign', role: 'owner', isOwned: false }] }])('does not grant management for an unsupported or unauthorized projection: %j', async extra => {
  h.invoke.mockResolvedValue(resource('owner', extra)); await render(); expect(result.selected).toBeUndefined();
});

it('never uses offline or revoked cached rows as authority', async () => {
  h.online = false; await render(); expect(reads()).toHaveLength(0); expect(result.selected).toBeUndefined();
  h.online = true; h.revoked = new Set(['mac']); await render(); expect(reads()).toHaveLength(0);
});

it('allows choosing among multiple independently verified computers', async () => {
  h.items = [row(), row('g1', h.targets[1])]; await render(); expect(result.managers).toHaveLength(2);
  await act(async () => { result.select('pc'); });
  await act(async () => { await result.act('add-member', { botId: 'local-pc-bot' }); });
  expect(writes()[0]?.[0]).toBe('pc');
});

it('does not send a write if the account changes while opening its link', async () => {
  await render(); let finish!: () => void;
  h.openLink.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let pending!: Promise<unknown>; await act(async () => { pending = result.act('update', { name: 'Late' }); });
  h.generation = 2; h.enabled = false; await render(); finish();
  await expect(pending).rejects.toThrow('PERMISSION_DENIED'); expect(writes()).toHaveLength(0);
});

it('ignores a late read after closing settings', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render();
  h.enabled = false; await render(); await act(async () => { finish(resource()); });
  expect(result.selected).toBeUndefined(); expect(writes()).toHaveLength(0);
});

it('preserves the revision of a name draft when sending it', async () => {
  await render(); await act(async () => { await result.act('update', { name: 'Draft', expectedRevision: 2 }); });
  expect(writes()[0]?.[2][0].input.expectedRevision).toBe(2);
});

it('disables a previously verified computer when presence goes offline', async () => {
  await render(); expect(result.selected).toBeDefined();
  h.online = false; await render(); expect(result.selected).toBeUndefined();
  await expect(result.act('update')).rejects.toThrow('PERMISSION_DENIED');
});

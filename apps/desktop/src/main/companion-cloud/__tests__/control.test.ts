import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { createCompanionHomeRegistry } from '../homes.js';
import { readTranscriptPage } from '../room.js';
import { startCompanionCloud, type CompanionCloudHost, type CompanionCloudRuntime, type CompanionRuntimeActor } from '../runtime.js';
import { fakeApi, fakeLocal, memoryState, rejection, type ApiHandler } from './fakes.js';

const ROOM = '10000000-0000-4000-8000-000000000001';
const device = (deviceId: string, extra: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId, name: deviceId, platform: 'darwin', appVersion: '1', lastSeenAt: null, online: true, busy: false,
  remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...extra,
});

let runtime: CompanionCloudRuntime | undefined;
afterEach(() => { runtime?.dispose(); runtime = undefined; });

function setup(options: { home: string | null; handler?: ApiHandler; devices?: DeviceLinkDeviceView[]; profiles?: string[] }) {
  const actors: CompanionRuntimeActor[] = [{ id: 'actor-1', kind: 'bot', externalId: 'bot_mia', name: 'Mia', avatar: null, homeDeviceId: options.home }];
  const { api, calls } = fakeApi(options.handler ?? ((route, method) => {
    if (route === '/preferences') return method === 'GET' ? [] : { revision: 1 };
    if (route === '/conversations') return { id: ROOM };
    if (route.includes('/messages?')) return [];
    if (route.endsWith('/import')) return {};
    if (method === 'PATCH') return {};
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const local = fakeLocal();
  const { state } = memoryState();
  const refresh = vi.fn(async () => undefined);
  const publish = vi.fn();
  const host: CompanionCloudHost = {
    homes: createCompanionHomeRegistry(), openState: () => state,
    readValues: async () => [{ key: 'companion.profile.v1', value: { name: 'Mia' } }],
    canonicalSession: async () => 'session-1', rowsAfter: async () => [], latestRows: async () => [],
    deliverToCanonical: async () => ({ ok: true }),
    materializer: local.host, listDevices: async () => options.devices ?? [],
  };
  runtime = startCompanionCloud({ api, host, endpoint: 'https://chat', humanActorId: 'human', selfDeviceId: 'desk', current: () => true,
    bots: () => actors.filter(a => a.homeDeviceId === 'desk' && !state.isDemoted(a.externalId)).map(a => ({ botId: a.externalId, actorId: a.id, name: a.name })),
    actors: () => actors, refresh, publish });
  return { runtime, actors, calls, local, state, refresh, publish };
}

describe('take over', () => {
  it('moves the home with compare-and-set, then builds the local companion', async () => {
    const t = setup({ home: 'laptop' });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(t.calls.find(call => call.method === 'PATCH')).toMatchObject({ route: '/actors/actor-1', data: { homeDeviceId: 'desk', expectedHomeDeviceId: 'laptop' } });
    expect(t.actors[0]!.homeDeviceId).toBe('desk');
    expect(t.local.host.createProfile).toHaveBeenCalledOnce();
    expect(t.publish).toHaveBeenCalled();
  });

  it('returns the current home when another device won', async () => {
    const t = setup({ home: 'laptop', handler: (_route, method) => {
      if (method === 'PATCH') throw rejection(409, 'HOME_DEVICE_CONFLICT', { homeDeviceId: 'tablet' });
      return [];
    } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'HOME_CONFLICT', homeDeviceId: 'tablet' });
    expect(t.refresh).toHaveBeenCalled();
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('reports an unreachable server as offline', async () => {
    const t = setup({ home: 'laptop', handler: () => { throw Object.assign(new Error('REQUEST_TIMEOUT')); } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'OFFLINE' });
  });

  it('is idempotent when this computer is already the home', async () => {
    const t = setup({ home: 'desk' });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
});

describe('reconcile', () => {
  it('demotes a local copy whose home is another computer', () => {
    const t = setup({ home: 'laptop' });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('materializes a companion handed to this computer once, and not a companion deleted here', async () => {
    const t = setup({ home: 'desk' });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.state.isDemoted('bot_mia')).toBe(false));
    expect(t.local.host.updateProfile).toHaveBeenCalledOnce();
    t.runtime.dispose();

    const deleted = setup({ home: 'desk' });
    deleted.state.update('bot_mia', 'actor-1', entry => { entry.mirror = { sessionId: 's', createdAt: 1, id: 'x' }; });
    deleted.runtime.reconcile([]);
    await Promise.resolve();
    expect(deleted.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('builds a companion this computer never had when it is handed here', async () => {
    const t = setup({ home: 'desk' });
    t.runtime.reconcile([]);
    await vi.waitFor(() => expect(t.local.host.createProfile).toHaveBeenCalledOnce());
  });
});

describe('transfer', () => {
  it('flushes uploads and the mirror before moving the home, then demotes locally', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')] });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: true });
    const order = t.calls.map(call => `${call.method} ${call.route}`);
    const patch = order.indexOf('PATCH /actors/actor-1');
    expect(order.indexOf('POST /preferences')).toBeLessThan(patch);
    expect(order.indexOf('POST /conversations')).toBeLessThan(patch);
    expect(t.calls[patch]!.data).toEqual({ homeDeviceId: 'laptop', expectedHomeDeviceId: 'desk' });
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    expect(t.actors[0]!.homeDeviceId).toBe('laptop');
  });

  it.each([
    ['unknown', []],
    ['offline', [device('laptop', { online: false })]],
    ['remote control off', [device('laptop', { remoteControlEnabled: false })]],
    ['a phone', [device('laptop', { platform: 'ios' })]],
  ])('rejects a target that is %s without touching the home', async (_name, devices) => {
    const t = setup({ home: 'desk', devices });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'TARGET_UNAVAILABLE' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('does not move the home when the flush cannot reach the server', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')], handler: (route, method) => {
      if (route === '/preferences' && method === 'GET') throw rejection(503, 'UNAVAILABLE');
      return {};
    } });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'OFFLINE' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(t.state.isDemoted('bot_mia')).toBe(false);
  });

  it('only transfers from the home computer', async () => {
    const t = setup({ home: 'laptop', devices: [device('tablet')] });
    expect(await t.runtime.transfer('bot_mia', 'tablet')).toMatchObject({ ok: false, code: 'FAILED', homeDeviceId: 'laptop' });
  });
});

describe('transcript', () => {
  it('maps authors to roles and pages oldest-first', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, seq: String(200 - i), authorId: i % 2 ? 'actor-1' : 'human',
      createdAt: new Date(1_700_000_000_000 - i * 1000).toISOString(), content: [{ type: 'text', text: `t${i}` }] }));
    page[1] = { ...page[1]!, content: [{ type: 'media', caption: 'a.png' } as never] };
    const { api } = fakeApi(() => page);
    const result = await readTranscriptPage(api, ROOM, 'actor-1');
    expect(result.nextBefore).toBe('101');
    expect(result.messages.at(-1)).toMatchObject({ id: 'm0', seq: '200', role: 'user', text: 't0' });
    expect(result.messages.at(-2)).toMatchObject({ id: 'm1', role: 'assistant', text: '[附件: a.png]' });
  });
});

describe('retire', () => {
  it('disables the cloud companion when it is deleted on its main computer', async () => {
    const t = setup({ home: 'desk' });
    await t.runtime.retire('bot_mia');
    expect(t.calls.filter(call => call.method === 'PATCH')).toEqual([expect.objectContaining({ route: '/actors/actor-1', data: { disabled: true } })]);
    expect(t.actors[0]!.disabled).toBe(true);
    // A retired companion is never revived or demoted again.
    t.runtime.reconcile([]);
    await Promise.resolve();
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['a demoted local copy', 'desk', true],
    ['a copy whose home is elsewhere', 'laptop', false],
  ])('leaves the cloud companion alone when deleting %s', async (_name, home, demoted) => {
    const t = setup({ home });
    if (demoted) t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    await t.runtime.retire('bot_mia');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
});

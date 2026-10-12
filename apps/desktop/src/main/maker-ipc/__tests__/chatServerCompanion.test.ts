import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: vi.fn() }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: () => '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), { limit: async () => [{ id: 'existing-local-group' }] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string; headers: Record<string, string> }, callback: (response: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        const target = new URL(url);
        void Promise.resolve().then(() => fixture.handle(target.pathname.slice(3) + target.search, options.method,
          data ? JSON.parse(data) : undefined, options.headers['X-Chat-Actor']))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200, headers: {} });
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
      },
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  } };
});
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 0; send = vi.fn();
    constructor() { super(); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import { createCompanionHomeRegistry } from '../../companion-cloud/homes.js';
import { createCompanionCloudState } from '../../companion-cloud/state.js';
import type { CompanionCloudHost } from '../../companion-cloud/runtime.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

const selfId = '30000000-0000-4000-8000-000000000001';
const botActor = '20000000-0000-4000-8000-000000000001';
const roomId = '10000000-0000-4000-8000-000000000001';
const sourceId = '50000000-0000-4000-8000-000000000001';
const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: roomId, source_message_id: sourceId,
  bot_id: botActor, requester_id: selfId, context_seq: '1', epoch: 1, status: 'running', access_mode: 'owner', access_revision: 1 };

describe('Chat Server cloud companions', () => {
  let service: BotGroupChatService;
  let deps: BotGroupChatServiceDeps;
  let host: CompanionCloudHost & { deliverToCanonical: ReturnType<typeof vi.fn> };
  let me: Record<string, unknown>;
  let home: string | null;
  let patch: (body: unknown) => { status?: number; body: unknown };
  let claimed: boolean;
  const calls = (route: string, method?: string) => fixture.handle.mock.calls.filter(([r, m]) => r === route && (!method || m === method));

  function respond(route: string, method: string, body: unknown) {
    if (route === '/me') return { body: me };
    if (route === '/actors' && method === 'GET') return { body: [{ id: botActor, kind: 'bot', externalId: 'local-bot', name: 'Mia', homeDeviceId: home }] };
    if (route === `/actors/${botActor}` && method === 'PATCH') return patch(body);
    if (route === '/executions/claim') { const next = claimed ? null : execution; claimed = true; return { body: { execution: next } }; }
    if (route === `/conversations/${roomId}/snapshot`) return { body: { room: { id: roomId, kind: 'direct', name: 'Mia', revision: 1 }, members: [], messages: [], cursor: '1' } };
    if (route === `/conversations/${roomId}/messages/${sourceId}`) return { body: { id: sourceId, seq: '1', authorId: selfId, author: { kind: 'human', name: 'Me' },
      deleted: false, threadRootId: null, createdAt: '2026-10-13T00:00:00Z', content: [{ type: 'text', text: 'hi' }, { type: 'media', mediaId: sourceId, caption: 'a.png' }] } };
    if (route === '/preferences') return { body: [] };
    return { body: {} };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.profiles = [{ id: 'local-bot', displayName: 'Mia', avatar: null, status: 'active' }];
    fixture.sockets = [];
    me = { actor: { id: selfId }, deviceId: 'desk-1', capabilities: { companionHome: true } };
    home = null; claimed = false;
    patch = () => { home = 'desk-1'; return { body: { id: botActor, homeDeviceId: 'desk-1' } }; };
    fixture.handle.mockImplementation((route, method, body) => respond(route, method, body));
    const files = new Map<string, string>();
    host = {
      homes: createCompanionHomeRegistry(),
      openState: (_endpoint, _human, current) => createCompanionCloudState({ filePath: 'state.json', current,
        io: { read: path => files.get(path) ?? null, write: (path, contents) => { files.set(path, contents); } } }),
      readValues: async () => [], canonicalSession: async () => null, rowsAfter: async () => [], latestRows: async () => [],
      deliverToCanonical: vi.fn(async () => ({ ok: true as const })),
    };
    deps = { ensureLane: vi.fn(), abortLane: vi.fn(async () => {}), dispatch: vi.fn(), companionCloud: host } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('claims an empty home for this computer once', async () => {
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(`/actors/${botActor}`, 'PATCH').map(call => call[2])).toEqual([{ homeDeviceId: 'desk-1', expectedHomeDeviceId: null }]);
    expect(host.homes.snapshot()).toMatchObject({ enabled: true, selfDeviceId: 'desk-1', humanActorId: selfId,
      actors: [{ id: botActor, externalId: 'local-bot', homeDeviceId: 'desk-1' }] });
    expect(host.homes.isHomeHere('local-bot')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(`/actors/${botActor}`, 'PATCH')).toHaveLength(1);
    expect(calls('/executions/claim').length).toBeGreaterThan(1);
  });

  it('adopts another computer as home and stops claiming its work', async () => {
    patch = () => { home = 'laptop'; return { status: 409, body: { error: { code: 'HOME_DEVICE_CONFLICT', details: { homeDeviceId: 'laptop' } } } }; };
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.homes.homeOf('local-bot')).toBe('laptop');
    expect(host.homes.isHomeHere('local-bot')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('/executions/claim')).toHaveLength(0);
  });

  it('stays inert on a server without companion homes', async () => {
    me = { actor: { id: selfId } };
    claimed = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.handle.mock.calls.filter(([route, method]) => route.startsWith('/actors/') && method === 'PATCH')).toHaveLength(0);
    expect(calls('/preferences')).toHaveLength(0);
    expect(host.homes.snapshot().enabled).toBe(false);
    expect(host.homes.isHomeHere('local-bot')).toBe(true);
  });

  it('delivers a 1:1 room message to the canonical Session and completes without content', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.deliverToCanonical).toHaveBeenCalledWith('local-bot', 'hi\n[附件: a.png]', `chat-direct:${execution.id}`);
    expect(deps.ensureLane).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    const results = fixture.handle.mock.calls.filter(([route, , body]) => route === `/conversations/${roomId}/executions/${execution.id}`
      && ['complete', 'fail'].includes(body?.action));
    expect(results).toHaveLength(1);
    expect(results[0]![2]).toMatchObject({ action: 'complete', continueDiscussion: false });
    expect(results[0]![2]).not.toHaveProperty('content');
    expect(results[0]![3]).toBe(botActor);
  });

  it('fails the execution with a short reason when the main task does not accept it', async () => {
    host.deliverToCanonical.mockResolvedValue({ ok: false, errorCode: 'TARGET_BOT_INACTIVE' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    const results = fixture.handle.mock.calls.filter(([route, , body]) => route === `/conversations/${roomId}/executions/${execution.id}`
      && ['complete', 'fail'].includes(body?.action));
    expect(results.map(call => call[2].action)).toEqual(['fail']);
    expect(typeof results[0]![2].detail).toBe('string');
  });

  it('re-reads homes immediately when the actor stream reports a move', async () => {
    claimed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.homes.homeOf('local-bot')).toBe('desk-1');
    const socket = fixture.sockets[0]!;
    socket.emit('message', JSON.stringify({ type: 'ready' }));
    home = 'laptop';
    const before = calls('/me').length;
    socket.emit('message', JSON.stringify({ type: 'changes', scope: `actor:${selfId}`, cursor: '2',
      changes: [{ type: 'actor.changed', entityId: botActor, data: { homeDeviceId: 'laptop' } }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('/me').length).toBe(before + 1);
    expect(host.homes.homeOf('local-bot')).toBe('laptop');
  });
});

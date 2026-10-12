/** 同账号托管任务的来源必须在首个请求前进入 proxy 的查询路径，且随运行实例收尾。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { buildUserProvider } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));

import { setCustomProviders } from '../../maker-host/active-catalog';
import { resolveSessionRouteDecision, setCustomProviderKeyReader } from '../../maker-host/provider-route';
import { bindHostedSessionProvider, clearAllSessionProviders, getSessionProvider, hasSessionProvider } from '../../maker-host/session-provider-store';
import { createRemoteAgentHost, hostSessionIdFor, type HostedStartInput } from '../host/runHost';

const MODEL = 'gpt-6-astra';
const OWNER = 'controller-1';
let root: string;
let host: ReturnType<typeof createRemoteAgentHost>;
let shadowRoots: Set<string>;
let releaseGates: Array<() => void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releaseGates.push(resolve);
  return { promise, resolve };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-hosted-route-')));
  shadowRoots = new Set();
  releaseGates = [];
  clearAllSessionProviders();
  setCustomProviders(['fp', 'other'].map((id) => buildUserProvider({
    id, name: id,
    runtimes: { codex: { baseUrl: 'https://' + id + '.example.invalid/v1', wireProtocol: 'openai-responses', models: [{ id: MODEL, name: MODEL }] } },
  })));
  setCustomProviderKeyReader((id) => 'test-key-' + id);
});

afterEach(async () => {
  for (const release of releaseGates) release();
  await host?.abortAll();
  host?.dispose();
  // dispose 在后台删除工作目录；等它结束，避免与 fixture 清理交错。
  await vi.waitFor(() => {
    for (const dir of shadowRoots) expect(fs.existsSync(dir)).toBe(false);
  });
  clearAllSessionProviders();
  setCustomProviders([]);
  setCustomProviderKeyReader(() => null);
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(hooks: { start?: (input: HostedStartInput) => Promise<void> } = {}) {
  const starts: HostedStartInput[] = [];
  const routes: unknown[] = [];
  const switches = vi.fn(async (_input: HostedStartInput) => {});
  const closed = vi.fn();
  host = createRemoteAgentHost({
    isAgentAvailable: () => true,
    isControllerAuthorized: () => true,
    providerAccess: {
      resolve: async (_kind, _model, providerId) => providerId === 'forbidden' ? null : providerId ?? 'fp',
      isAllowed: (providerId) => providerId !== 'forbidden',
    },
    bindOwnerProviderRoute: bindHostedSessionProvider,
    startHosted: async (input) => {
      starts.push(input);
      shadowRoots.add(path.dirname(input.mirrorRoot));
      // 与 Codex proxy 相同的解析器：核对实际 upstream 与凭证，而不只看传入的 providerId。
      routes.push(await resolveSessionRouteDecision(input.hostSessionId, 'codex', 'unused-gateway-key', MODEL));
      await hooks.start?.(input);
      const end = deferred();
      return {
        id: 'sdk-' + input.hostSessionId, agentKind: 'codex', model: MODEL,
        async send() {}, async steer() {}, async abort() {},
        async close() { closed(); end.resolve(); },
        async setModel() { await switches(input); },
        events: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> { await end.promise; } }),
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
        setInteractionResolver() {},
      } satisfies AgentSessionHandle;
    },
    captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: path.join(root, 'host'),
  });
  return { starts, routes, switches, closed };
}

async function open(providerId: string | null = 'fp', sessionId = 'task-1', controller = OWNER) {
  const runId = randomUUID();
  await host.handle(controller, {
    op: 'open', runId, agentKind: 'codex', payload: { json: {
      sessionId, options: { model: MODEL, providerId },
      // 控制端的逻辑 POSIX 路径，与测试宿主平台无关。
      workspace: { workingDir: '/Users/owner/proj', platform: 'darwin', shell: 'zsh' },
      projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
    } },
  });
  return runId;
}

async function events(runId: string, controller = OWNER): Promise<Array<Record<string, unknown>>> {
  const poll = await host.handle(controller, { op: 'poll', runs: [{ runId, cursor: 0 }], waitMs: 0 }) as { runs: Array<{ data?: string }> };
  return Buffer.from(poll.runs[0]?.data ?? '', 'base64').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForEvent(runId: string, type: string, callId?: string, controller = OWNER) {
  let found: Record<string, unknown> | undefined;
  await vi.waitFor(async () => {
    found = (await events(runId, controller)).find((event) => event.t === type && (!callId || event.callId === callId));
    expect(found).toBeDefined();
  });
  return found!;
}

async function switchProvider(runId: string, providerId?: string | null) {
  const callId = randomUUID();
  await host.handle(OWNER, { op: 'call', runId, callId, method: 'setModel', payload: { json: [MODEL, providerId === undefined ? {} : { providerId }] } });
  return callId;
}

describe('same-account hosted provider routing', () => {
  it.each(['fp', null])('routes the first request to the authorized custom provider (%s)', async (providerId) => {
    const { routes } = setup();
    const runId = await open(providerId);
    await waitForEvent(runId, 'started');
    expect(routes).toEqual([expect.objectContaining({
      upstreamOverride: 'https://fp.example.invalid/v1',
      headerOverride: expect.objectContaining({ authorization: 'Bearer test-key-fp' }),
    })]);
    await host.handle(OWNER, { op: 'close', runId, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('registers source changes before calling the agent, keeps model-only changes, and rolls back failures', async () => {
    const id = hostSessionIdFor(OWNER, 'task-1');
    const { switches } = setup();
    switches.mockImplementation(async () => { expect(getSessionProvider(id)).toBe('other'); });
    const runId = await open();
    await waitForEvent(runId, 'started');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, 'other'))).toMatchObject({ ok: true });
    expect(getSessionProvider(id)).toBe('other');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId))).toMatchObject({ ok: true });
    expect(getSessionProvider(id)).toBe('other');
    switches.mockImplementationOnce(async () => {
      expect(getSessionProvider(id)).toBe('fp');
      throw new Error('switch failed');
    });
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, null))).toMatchObject({ ok: false });
    expect(getSessionProvider(id)).toBe('other');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, 'forbidden'))).toMatchObject({ ok: false });
    expect(getSessionProvider(id)).toBe('other');
    expect(switches).toHaveBeenCalledTimes(3);
  });

  it('serializes source changes so a failed earlier change cannot overwrite the next choice', async () => {
    const pending = deferred();
    const { switches } = setup();
    const runId = await open();
    await waitForEvent(runId, 'started');
    switches.mockImplementationOnce(async () => { await pending.promise; throw new Error('switch failed'); });
    const first = await switchProvider(runId, 'other');
    await vi.waitFor(() => expect(switches).toHaveBeenCalledTimes(1));
    const second = await switchProvider(runId, 'fp');
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('other');
    pending.resolve();
    expect(await waitForEvent(runId, 'result', first)).toMatchObject({ ok: false });
    expect(await waitForEvent(runId, 'result', second)).toMatchObject({ ok: true });
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('fp');
  });

  it('releases registration on startup failure', async () => {
    setup({ start: async () => { throw new Error('start failed'); } });
    const runId = await open();
    await waitForEvent(runId, 'closed');
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('does not re-register a cancelled startup when its agent finally returns', async () => {
    const pending = deferred();
    const { routes, closed } = setup({ start: () => pending.promise });
    const runId = await open();
    await vi.waitFor(() => expect(routes).toHaveLength(1));
    await host.handle(OWNER, { op: 'close', runId, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
    pending.resolve();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('keeps a reconnected task and another controller registered when an old switch fails late', async () => {
    const pending = deferred();
    const { switches } = setup();
    const first = await open();
    await waitForEvent(first, 'started');
    const peer = await open('other', 'task-1', 'controller-2');
    await waitForEvent(peer, 'started', undefined, 'controller-2');
    switches.mockImplementationOnce(async () => { await pending.promise; throw new Error('old switch failed'); });
    await switchProvider(first, 'other');
    await vi.waitFor(() => expect(switches).toHaveBeenCalledTimes(1));
    const replacement = await open('other');
    await waitForEvent(replacement, 'started');
    pending.resolve();
    await vi.waitFor(() => expect(switches.mock.settledResults[0]?.type).toBe('rejected'));
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('other');
    expect(getSessionProvider(hostSessionIdFor('controller-2', 'task-1'))).toBe('other');
    await host.handle(OWNER, { op: 'close', runId: replacement, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
    expect(getSessionProvider(hostSessionIdFor('controller-2', 'task-1'))).toBe('other');
  });
});

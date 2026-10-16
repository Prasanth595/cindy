/**
 * taskService.test.ts
 * ---------------------------------------------------------------------------
 * 外部调用一单任务的完整路径(注入内存 fake,不启动 Electron / 不碰数据库):
 *   提交校验 → 按 key 复用/新建会话 → 投递 → 观察收口 → 取文本 → 回调。
 * 覆盖的失败路径:同 key 并发 BUSY、会话忙 BUSY、超时、取消、非法入参。
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@cindy/maker-core';

import { createPartnerTaskService } from '../taskService.js';
import type { PartnerBridgeDeps, PartnerSessionRow } from '../types.js';

type StatusListener = (status: 'active' | 'aborting' | 'closed' | 'error') => void;

function createFakeSession(id: string) {
  const eventListeners = new Set<(ev: AgentEvent) => void>();
  const statusListeners = new Set<StatusListener>();
  return {
    id,
    onEvent(listener: (ev: AgentEvent) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStatusChange(listener: StatusListener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    emitText(text: string) {
      for (const listener of [...eventListeners]) {
        listener({ type: 'text', data: { text, isFinal: true } } as unknown as AgentEvent);
      }
    },
    emitDone() {
      for (const listener of [...eventListeners]) {
        listener({ type: 'done', data: {} } as unknown as AgentEvent);
      }
    },
  };
}

function createHarness() {
  const sessions = new Map<string, ReturnType<typeof createFakeSession>>();
  const rows = new Map<string, PartnerSessionRow>();
  const keyToSession = new Map<string, string>();
  const dispatched: { targetSessionId: string; message: string }[] = [];
  const aborted: string[] = [];
  const callbacks: { url: string; payload: unknown }[] = [];
  const created: string[] = [];

  const deps: PartnerBridgeDeps = {
    readSessionId: (key) => keyToSession.get(key) ?? null,
    writeSessionId: (key, sessionId) => {
      if (sessionId === null) keyToSession.delete(key);
      else keyToSession.set(key, sessionId);
    },
    getSessionRow: async (id) => rows.get(id) ?? null,
    createSession: async () => {
      const id = `sess-${rows.size + 1}`;
      created.push(id);
      rows.set(id, {
        status: 'active',
        agentKind: 'cc',
        permissionMode: 'plan',
        workingDir: null,
        workspaceKind: 'dialogue',
      });
      sessions.set(id, createFakeSession(id));
      return id;
    },
    getDraftDefaults: () => ({}),
    normalizeWorkingDir: (dir) => (dir.startsWith('/') ? dir : null),
    isSessionBusy: () => false,
    dispatch: async (params) => {
      dispatched.push(params);
      return { ok: true, wakeKind: 'created' };
    },
    abortSession: async (id) => {
      aborted.push(id);
    },
    getObservableSession: (id) => sessions.get(id) ?? null,
    onSilentStopSettled: () => () => {},
    readLatestAssistantText: async () => null,
    resolveAttachments: async ({ text }) => ({ text, attachments: [] }),
    deliverCallback: async (url, payload) => {
      callbacks.push({ url, payload });
    },
    log: { info: () => {}, warn: () => {} },
    sleep: async () => {},
  };

  return { deps, sessions, rows, keyToSession, dispatched, aborted, callbacks, created };
}

/** 会话是在后台分支里建的,断言前先等它出现。 */
async function waitForSession(h: ReturnType<typeof createHarness>) {
  await vi.waitFor(() => {
    expect(h.sessions.size).toBe(1);
  });
  return [...h.sessions.values()][0];
}

describe('partner task service', () => {
  it('提交后跑完一轮,取回文本并复用同一间会话', async () => {
    const h = createHarness();
    const service = createPartnerTaskService(h.deps);

    const first = await service.submit({ key: 'wechat:u1', prompt: '帮我看下今天的订单' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const taskId = first.task.taskId;
    const session = await waitForSession(h);
    const sessionId = h.keyToSession.get('wechat:u1');
    expect(sessionId).toBeDefined();

    session.emitText('订单有三笔待发货。');
    session.emitDone();
    await vi.waitFor(() => {
      expect(service.get(taskId)?.status).toBe('succeeded');
    });
    expect(service.get(taskId)?.text).toBe('订单有三笔待发货。');
    expect(service.get(taskId)?.sessionId).toBe(sessionId);

    // 同 key 第二次:复用会话,不新建第二间。
    const second = await service.submit({ key: 'wechat:u1', prompt: '那再查下退款' });
    expect(second.ok).toBe(true);
    expect(h.created).toHaveLength(1);
    await vi.waitFor(() => {
      expect(h.dispatched).toHaveLength(2);
    });
  });

  it('完成后回调调用方地址', async () => {
    const h = createHarness();
    const service = createPartnerTaskService(h.deps);
    const submitted = await service.submit({
      key: 'erp:order-1',
      prompt: '生成对账单',
      callbackUrl: 'http://127.0.0.1:9911/cindy/hook',
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const session = await waitForSession(h);
    session.emitText('对账单已生成');
    session.emitDone();

    await vi.waitFor(() => {
      expect(h.callbacks).toHaveLength(1);
    });
    const payload = h.callbacks[0].payload as { status: string; text: string; taskId: string };
    expect(h.callbacks[0].url).toBe('http://127.0.0.1:9911/cindy/hook');
    expect(payload.status).toBe('succeeded');
    expect(payload.text).toBe('对账单已生成');
    expect(payload.taskId).toBe(submitted.task.taskId);
  });

  it('同 key 上一单在途时第二单直接 BUSY', async () => {
    const h = createHarness();
    const service = createPartnerTaskService(h.deps);
    const first = await service.submit({ key: 'k', prompt: '第一单' });
    expect(first.ok).toBe(true);
    const second = await service.submit({ key: 'k', prompt: '第二单' });
    expect(second).toEqual({
      ok: false,
      errorCode: 'BUSY',
      message: '这个 key 已有一单在途,等它结束或换一个 key',
    });

    const session = await waitForSession(h);
    session.emitDone();
    await vi.waitFor(() => expect(service.runningCount()).toBe(0));
  });

  it('会话正被占用时判 BUSY', async () => {
    const h = createHarness();
    h.deps.isSessionBusy = () => true;
    const service = createPartnerTaskService(h.deps);
    const submitted = await service.submit({ key: 'k2', prompt: '干活' });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    await vi.waitFor(() => {
      expect(service.get(submitted.task.taskId)?.status).toBe('failed');
    });
    expect(service.get(submitted.task.taskId)?.errorCode).toBe('BUSY');
    expect(h.dispatched).toHaveLength(0);
  });

  it('一轮不结束则超时收口,任务记 TIMEOUT', async () => {
    const h = createHarness();
    const service = createPartnerTaskService({ ...h.deps, turnTimeoutMs: 20 });
    const submitted = await service.submit({ key: 'slow', prompt: '慢活' });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    await vi.waitFor(
      () => {
        expect(service.get(submitted.task.taskId)?.status).toBe('failed');
      },
      { timeout: 2000 },
    );
    expect(service.get(submitted.task.taskId)?.errorCode).toBe('TIMEOUT');
  });

  it('取消会中止会话这一轮并落 cancelled', async () => {
    const h = createHarness();
    const service = createPartnerTaskService(h.deps);
    const submitted = await service.submit({ key: 'cancel-me', prompt: '长任务' });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    await vi.waitFor(() => {
      expect(h.dispatched).toHaveLength(1);
    });
    const outcome = await service.cancel(submitted.task.taskId);
    expect(outcome.ok).toBe(true);
    await vi.waitFor(() => {
      expect(service.get(submitted.task.taskId)?.status).toBe('cancelled');
    });
    expect(h.aborted).toEqual([h.keyToSession.get('cancel-me')]);
  });

  it('拒绝非法入参', async () => {
    const h = createHarness();
    const service = createPartnerTaskService(h.deps);
    expect(await service.submit({ key: 'k', prompt: '   ' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await service.submit({ key: '', prompt: 'x' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      await service.submit({ key: 'k', prompt: 'x', callbackUrl: 'file:///etc/passwd' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(
      await service.submit({ key: 'k', prompt: 'x', workingDir: 'relative/dir' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });
});

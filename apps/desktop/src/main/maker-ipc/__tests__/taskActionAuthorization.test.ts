/**
 * Value: production tool admission + queued dispatch guards, no real account or network.
 * Regression: task actions added owner consent checks after the normal runtime permission flow.
 * Gap: workbench tests cover visibility; SDK approval tests cannot prove Host consent.
 * Minimum input: non-owner provenance + runtime change; live execution modes do not review twice.
 * Tier: unit. This file isolates the process-local authorization lifetime from SQLite/IPC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoReviewDecision, PermissionMode, SendOrigin } from '@cindy/maker-core';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { withToolCallAuthority } from '../../../../../../packages/lizi-mcps/src/tool-call-authority.js';
import { createOrcaMcpServer } from '../../../../../../packages/lizi-mcps/src/orca/server.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  approvedTaskDelegation,
  bindTaskActionInput,
  createTaskActionAuthorizer,
  taskActionInputGuard,
  hasTaskActionAuthorization,
  TASK_ACTION_TOOLS,
  ORCA_TASK_ACTION_TOOLS,
  captureTaskActionSyncGuard,
  captureTaskActionGuard,
  captureTaskActionDeliveryGuard,
  assertTaskActionCurrent,
  runHostCompletionDelivery,
} from '../taskActionAuthorization.js';

function fixture(ownerInput = false, delegated = false) {
  let current = true;
  const confirm = vi.fn(async () => true);
  const authorize = createTaskActionAuthorizer({
    capture: async () => ({
      key: 'accepted-input',
      ownerInput,
      delegated,
      assertCurrent: async () => {
        if (!current) throw new Error('revoked');
      },
    }),
    confirm,
  });
  return {
    authorize,
    confirm,
    revoke: () => {
      current = false;
    },
  };
}
const call = (tool = 'continue_workbench_task') => ({
  sessionId: 'companion',
  server: 'cindy_helper' as const,
  tool,
  args: { task_id: 'task', message: 'Continue the approved work' },
});
const input = (): AgentInputQueuedMessage => ({
  clientId: 'queued',
  text: 'Approved body',
  persistedContent: 'Approved body',
  model: 'model',
  effort: '',
  permissionMode: 'bypassPermissions',
  workingDir: '/tmp/test',
  chatMessage: { clientId: 'queued', role: 'user', content: 'Approved body' },
  createOpts: { agentKind: 'codex', workingDir: '/tmp/test', model: 'model' },
  origin: {
    kind: 'session',
    senderSessionId: 'companion',
    senderBotId: 'bot',
    displayText: 'Approved body',
  },
});

describe('Host task action authorization', () => {
  it('permits observation and notification, but rejects every alternate task-write entrance before effects', async () => {
    const h = fixture();
    const queue: string[] = [];
    let route = 'original';
    for (const tool of TASK_ACTION_TOOLS) {
      const result = await withToolCallAuthority(h.authorize, call(tool), async () => {
        queue.push('unauthorized');
        route = 'changed';
        return { ok: true };
      });
      expect(result).toMatchObject({ isError: true });
    }
    for (const tool of ORCA_TASK_ACTION_TOOLS) {
      expect(
        await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server: 'cindy_orca' },
          async () => {
            queue.push('unauthorized');
          },
        ),
      ).toMatchObject({ isError: true });
    }
    expect(queue).toEqual([]);
    expect(route).toBe('original');
    expect(h.confirm).not.toHaveBeenCalled();
    for (const tool of ['get_task_digest', 'get_workbench', 'schedule_notify_current_run']) {
      expect(
        await withToolCallAuthority(h.authorize, call(tool), async () => 'read-or-remind'),
      ).toBe('read-or-remind');
    }
  });

  it('binds a real confirmation to one exact invocation and consumes it once', async () => {
    const h = fixture(true);
    const request = call();
    const decision = await h.authorize(request);
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args);
    if (!decision.ok || !decision.run) throw new Error('missing Host grant');
    const operation = vi.fn(async () => 'sent');
    expect(await decision.run(operation)).toBe('sent');
    await expect(decision.run(operation)).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(['task_id', 'message'] as const)(
    'rejects a changed %s after confirmation',
    async (key) => {
      const h = fixture(true),
        request = call();
      const decision = await h.authorize(request);
      request.args[key] = 'different';
      const operation = vi.fn(async () => 'sent');
      if (!decision.ok || !decision.run) throw new Error('missing Host grant');
      await expect(decision.run(operation)).rejects.toThrow('AUTHORIZATION_EXPIRED');
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('does not let approval racing with revocation execute', async () => {
    const h = fixture(true);
    h.confirm.mockImplementation(async () => {
      h.revoke();
      return true;
    });
    expect(await h.authorize(call())).toMatchObject({
      ok: false,
      errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
    });
  });

  it('reuses a verified delegation without another confirmation and mints creation evidence only in the Host call', async () => {
    const h = fixture(false, true);
    expect(approvedTaskDelegation('companion')).toBeUndefined();
    expect(
      await withToolCallAuthority(
        h.authorize,
        call('message_session_task'),
        async () => 'continued',
      ),
    ).toBe('continued');
    expect(h.confirm).not.toHaveBeenCalled();
    const owner = fixture(true);
    const receipt = await withToolCallAuthority(
      owner.authorize,
      call('start_session_task'),
      async () => approvedTaskDelegation('companion'),
    );
    expect(receipt).toMatchObject({
      version: 1,
      actions: expect.arrayContaining(['message_session_task']),
    });
    expect(approvedTaskDelegation('companion')).toBeUndefined();
  });

  it('checks delayed input again, rejects target/content changes and cannot restore authority from JSON', async () => {
    const h = fixture(true),
      queued = input();
    await withToolCallAuthority(h.authorize, call(), async () => {
      bindTaskActionInput('target', queued);
    });
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    await expect(taskActionInputGuard('another', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
    await expect(
      taskActionInputGuard('target', { ...queued, text: 'different' })!(),
    ).rejects.toThrow('AUTHORIZATION_EXPIRED');
    await expect(
      taskActionInputGuard('target', JSON.parse(JSON.stringify(queued)))!(),
    ).rejects.toThrow('AUTHORIZATION_REQUIRED');
    h.revoke();
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('revoked');
  });

  it('holds old Bot queue rows on upgrade without deleting sent history or treating ordinary user input as automatic', async () => {
    await expect(taskActionInputGuard('target', input())!()).rejects.toThrow(
      'AUTHORIZATION_REQUIRED',
    );
    expect(taskActionInputGuard('target', { ...input(), origin: undefined })).toBeUndefined();
  });
});

// Regression #6703: a delegated task's terminal wake-up is a Host system receipt delivered in a
// later turn, so the turn credential captured when it started has necessarily expired. Unit tier.
describe('Host system receipts', () => {
  it('delivers outside the starting turn credential and leaves that scope untouched', async () => {
    const h = fixture(true);
    await withToolCallAuthority(h.authorize, call('start_session_task'), async () => {
      expect(hasTaskActionAuthorization('companion')).toBe(true);
      expect(captureTaskActionGuard()).not.toBeUndefined();
      await runHostCompletionDelivery(async () => {
        expect(hasTaskActionAuthorization('companion')).toBe(false);
        expect(captureTaskActionGuard()).toBeUndefined();
        expect(captureTaskActionSyncGuard()).toBeUndefined();
        expect(captureTaskActionDeliveryGuard()).toBeUndefined();
        await expect(assertTaskActionCurrent()).resolves.toBeUndefined();
        // A later turn cannot turn a receipt into a new Agent action.
        expect(approvedTaskDelegation('companion')).toBeUndefined();
        const queued = { ...input(), origin: undefined };
        bindTaskActionInput('target', queued);
        expect(queued.taskActionRequiresAuthorization).toBeUndefined();
        expect(taskActionInputGuard('target', queued)).toBeUndefined();
      });
      expect(hasTaskActionAuthorization('companion')).toBe(true);
    });
  });

  it('keeps the receipt deliverable after the starting turn boundary moved', async () => {
    let boundaryMoved = false;
    const authorize = createTaskActionAuthorizer({
      capture: async () => ({
        key: 'accepted-input',
        ownerInput: true,
        delegated: false,
        assertCurrent: async () => {
          if (boundaryMoved) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
        },
      }),
      confirm: async () => true,
    });
    const decision = await authorize(call('send_to_session'));
    if (!decision.ok || !decision.run) throw new Error('missing Host grant');
    await decision.run(async () => {
      boundaryMoved = true;
      await expect(assertTaskActionCurrent()).rejects.toThrow('AUTHORIZATION_EXPIRED');
      await expect(runHostCompletionDelivery(assertTaskActionCurrent)).resolves.toBeUndefined();
    });
  });

  // Regression #6756: a Host receipt is not an Agent action, so it must not read a still-live
  // outer turn grant even when it is delivered from inside that outer scope.
  it('delivers as Host work even when an outer turn scope is still live', async () => {
    const assertCurrent = vi.fn(async () => {});
    const authorize = createTaskActionAuthorizer({
      capture: async () => ({
        key: 'accepted-input',
        ownerInput: true,
        delegated: false,
        assertCurrent,
      }),
      confirm: async () => true,
    });
    const outer = await authorize(call('start_session_task'));
    if (!outer.ok || !outer.run) throw new Error('missing Host grant');
    await outer.run(async () => {
      const inner = await authorize(call('send_to_session'));
      if (!inner.ok || !inner.run) throw new Error('missing Host grant');
      await inner.run(async () => {
        const beforeDelivery = assertCurrent.mock.calls.length;
        await expect(
          runHostCompletionDelivery(async () => {
            await assertTaskActionCurrent();
            expect(hasTaskActionAuthorization('companion')).toBe(false);
            expect(assertCurrent).toHaveBeenCalledTimes(beforeDelivery);
          }),
        ).resolves.toBeUndefined();
      });
      expect(hasTaskActionAuthorization('companion')).toBe(true);
    });
  });
});

// Regression #6399: the pure scope fixture above cannot detect lost group owner
// provenance or a second confirmation added to the owner's ordinary tool flow.
// Exercise the Desktop adapter + real group registry + shared helper/Orca entry.
// SQLite/account/routine IO is replaced with in-memory facts (unit tier).
const hostFacts = vi.hoisted(() => ({ getDb: vi.fn(), boundaryPending: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ tryGetDbClient: hostFacts.getDb }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: hostFacts.boundaryPending,
}));
vi.mock('../../routines/service.js', () => ({
  readActiveFollowUpRoutine: () => ({ enabled: false, revision: 1 }),
}));
import { botDelegations, orcaTeams } from '../../localDb/schema.js';
import { createDesktopTaskActionAuthorizer } from '../taskActionHost.js';
import { OrcaWorkerPermissionConfirmBridge } from '../orcaWorkerPermissionConfirmBridge.js';
import { taskActionConfirmationCopy } from '../taskActionConfirmation.js';
import { MAKER_PUSH } from '../channels.js';
import {
  registerGroupToolAuthority,
  GroupToolAuthorizationError,
} from '../botGroupToolAuthorization.js';

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).forEach((release) => release());
});
function desktopFixture(kind: 'private' | 'group' | 'automatic' = 'group') {
  const caller = {
    source: 'bot',
    role: kind === 'group' ? 'group' : 'canonical',
    botId: 'bot' as string | null,
    botStatus: 'active',
    status: 'active',
    archivedAt: null,
    clearedAt: null,
  };
  const rows = {
    delegation: null as null | {
      status: string;
      runSequence: number;
      permissionSnapshotJson: string;
    },
    team: null as null | { id: string },
  };
  const db = {
    drizzle: {
      select: () => {
        let table: unknown;
        const query = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          leftJoin: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: async () =>
            table === botDelegations
              ? rows.delegation
                ? [rows.delegation]
                : []
              : table === orcaTeams
                ? rows.team
                  ? [rows.team]
                  : []
                : [caller],
        };
        return query;
      },
    },
  };
  hostFacts.getDb.mockReturnValue(db);
  hostFacts.boundaryPending.mockReturnValue(false);
  const activeInput = {
    permission: undefined as undefined | null | {
      permissionMode: string;
      planModeEnabled: boolean;
      isCurrent(): boolean;
    },
    orcaSenderSessionId: undefined as string | undefined,
    key: 'owner-request',
    ownerInput: kind === 'private',
    automatic: kind !== 'private',
    boundary: 'runtime-1',
  };
  const confirm = vi.fn<
    (sessionId: string, tool: string, args: unknown) => Promise<boolean>
  >(async () => true);
  const runtime = {
    stablePermissionModeState: { mode: 'auto' as PermissionMode, generation: 1 },
    stablePlanModeState: { enabled: false, generation: 1 },
    getCurrentTurnOrigin: (): SendOrigin | null => null,
    reviewHostPermissionAction: vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'allow' })),
  };
  const getSession = vi.fn((): typeof runtime | undefined => runtime);
  const authorize = createDesktopTaskActionAuthorizer({
    input: () => ({ ...activeInput }), confirm, getSession,
  });
  return { authorize, confirm, activeInput, caller, rows, runtime, getSession };
}
const ownerWrites = [
  ['cindy_helper', 'start_session_task'],
  ['cindy_helper', 'send_to_session'],
  ['cindy_helper', 'continue_workbench_task'],
  ['cindy_helper', 'set_workbench_task_responsibility'],
  ['cindy_helper', 'set_session_runtime'],
  ['cindy_orca', 'create_worker'],
  ['cindy_orca', 'send_to_worker'],
  ['cindy_orca', 'switch_focus'],
] as const;

// Regression #6399 / maker-core-and-agent-behavior.md "同范围自动跟进":
// production Desktop admission must deliver a user-scheduled send after normal
// permission review. Existing Bot-only automatic fixtures miss ordinary schedules.
// Minimum: ordinary scheduled turn + approved send_to_session; unit, in-memory IO.
// Standalone Vitest run: 2.72s (4.4s command wall time on Windows).
describe('Owner-delegated scheduled task actions', () => {
  function scheduledFixture() {
    const h = desktopFixture('automatic');
    h.caller.botId = null;
    h.caller.source = 'scheduler';
    const origin: SendOrigin = { kind: 'scheduler', runId: 'run-1' };
    h.runtime.getCurrentTurnOrigin = () => origin;
    return h;
  }
  const scheduledSend = () => ({
    ...call('send_to_session'),
    args: { target_session_id: 'target', message: 'Dispatch the new PR feedback' },
  });

  it('reuses a live scheduled permission flow without invoking the recovery reviewer', async () => {
    const h = scheduledFixture();
    h.activeInput.permission = {
      permissionMode: 'auto', planModeEnabled: false, isCurrent: () => true,
    };
    expect(await withToolCallAuthority(h.authorize, scheduledSend(), async () => 'sent')).toBe('sent');
    expect(h.runtime.reviewHostPermissionAction).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['direct', 'queued', 'bound'] as const)('delivers an approved %s scheduled dispatch without another confirmation', async route => {
    const h = scheduledFixture();
    if (route === 'bound') h.caller.source = 'desktop';
    h.activeInput.automatic = route === 'queued';
    const request = scheduledSend();
    const queued = input();
    const result = await withToolCallAuthority(h.authorize, request, async () => {
      bindTaskActionInput('target', queued);
      return 'sent';
    });
    expect(result).toBe('sent');
    // The admitted message can wait behind busy work after its source turn ends.
    h.runtime.getCurrentTurnOrigin = () => null;
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    expect(h.runtime.reviewHostPermissionAction).toHaveBeenCalledWith({
      kind: 'other',
      description: JSON.stringify({
        toolName: 'mcp__cindy_helper__send_to_session',
        input: request.args,
        context: { source: 'scheduler', phase: 'triggered-continuation' },
      }),
    });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['bot', 'forwarded', 'missing-runtime', 'plan'] as const)('does not infer consent from %s scheduled metadata', async source => {
    const h = scheduledFixture();
    if (source === 'bot') h.caller.botId = 'bot';
    if (source === 'forwarded') h.runtime.getCurrentTurnOrigin = () => null;
    if (source === 'missing-runtime') h.getSession.mockReturnValue(undefined);
    if (source === 'plan') h.runtime.stablePlanModeState.enabled = true;
    // A Bot lane asks its owner instead of inferring consent; a refused card still denies.
    if (source === 'bot') h.confirm.mockResolvedValueOnce(false);
    const effect = vi.fn(async () => 'sent');
    expect(await withToolCallAuthority(h.authorize, scheduledSend(), effect)).toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.runtime.reviewHostPermissionAction).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledTimes(source === 'bot' ? 1 : 0);
  });

  it.each(['block', 'ask', 'cancel'] as const)('respects a normal %s permission decision', async verdict => {
    const h = scheduledFixture();
    h.runtime.reviewHostPermissionAction.mockResolvedValue({ verdict: verdict === 'cancel' ? 'ask' : verdict });
    h.confirm.mockResolvedValue(verdict !== 'cancel');
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, scheduledSend(), effect);
    if (verdict === 'ask') expect(result).toBe('sent');
    else expect(result).toMatchObject({ isError: true });
    expect(effect).toHaveBeenCalledTimes(verdict === 'ask' ? 1 : 0);
    expect(h.confirm).toHaveBeenCalledTimes(verdict === 'block' ? 0 : 1);
  });

  it.each(['message', 'target_session_id'] as const)('rejects %s rewritten while the permission review is pending', async key => {
    const h = scheduledFixture();
    const request = scheduledSend();
    h.runtime.reviewHostPermissionAction.mockImplementation(async () => {
      request.args[key] = 'unreviewed';
      return { verdict: 'allow' };
    });
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, request, effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['permission', 'plan', 'instance', 'account', 'input'] as const)('invalidates admission and delayed delivery after %s changes', async changed => {
    const h = scheduledFixture();
    const queued = input();
    const guard = await withToolCallAuthority(h.authorize, scheduledSend(), async () => {
      bindTaskActionInput('target', queued);
      return captureTaskActionSyncGuard()!;
    });
    if (typeof guard !== 'function') throw new Error('Expected an admitted delivery guard');
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    expect(() => guard()).not.toThrow();
    if (changed === 'permission') h.runtime.stablePermissionModeState.generation++;
    if (changed === 'plan') h.runtime.stablePlanModeState.generation++;
    if (changed === 'instance') h.getSession.mockReturnValue({ ...h.runtime });
    if (changed === 'account') hostFacts.boundaryPending.mockReturnValue(true);
    if (changed === 'input') h.activeInput.boundary = 'replacement-runtime';
    expect(() => guard()).toThrow('AUTHORIZATION_EXPIRED');
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('AUTHORIZATION_EXPIRED');
  });

  it.each(['permission', 'account', 'turn'] as const)('does not act or prompt if %s changes during review', async changed => {
    const h = scheduledFixture();
    h.runtime.reviewHostPermissionAction.mockImplementation(async () => {
      if (changed === 'permission') h.runtime.stablePermissionModeState.generation++;
      if (changed === 'account') hostFacts.boundaryPending.mockReturnValue(true);
      if (changed === 'turn') h.runtime.getCurrentTurnOrigin = () => ({ kind: 'scheduler', runId: 'run-2' });
      return { verdict: 'ask' };
    });
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, scheduledSend(), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe('Desktop owner input task actions', () => {
  // Runtime permission decisions must survive missing owner provenance (including resumed turns).
  // Exercise admission and the downstream queue receipt, not only a mode predicate.
  it.each(['bypassPermissions', 'auto', 'ask', 'default', 'acceptEdits'])(
    'honors the live %s permission flow for helper and Orca without another confirmation', async permissionMode => {
      const h = desktopFixture('automatic');
      h.activeInput.permission = {
        permissionMode, planModeEnabled: false, isCurrent: () => true,
      };
      for (const [server, tool] of ownerWrites) {
        // Host admission can reuse approval only if the production tool policy
        // actually routes this mutation through the runtime permission flow.
        expect(getDesktopMcpToolApprovalPolicy({ serverName: server, toolName: tool }))
          .toBe('prompt-each-time');
        expect(await withToolCallAuthority(h.authorize, { ...call(tool), server }, async () => {
          expect(hasTaskActionAuthorization('companion')).toBe(true);
          const queued = input();
          bindTaskActionInput('target', queued);
          await taskActionInputGuard('target', queued)!();
          return 'changed';
        })).toBe('changed');
      }
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(['unknown', 'plan', 'active-plan', 'stale', 'shared'])(
    'does not admit a runtime permission decision from %s state', async state => {
      const h = desktopFixture('automatic');
      h.activeInput.permission = {
        permissionMode: ['unknown', 'plan'].includes(state) ? state : 'auto',
        planModeEnabled: state === 'active-plan', isCurrent: () => state !== 'stale',
      };
      if (state === 'shared') h.caller.source = 'shared';
      // A state that cannot authorize at all still asks the owner when the lane allows it.
      const asksOwner = state === 'unknown';
      if (asksOwner) h.confirm.mockResolvedValue(false);
      const effect = vi.fn(async () => 'changed');
      expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect))
        .toMatchObject({ isError: true });
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledTimes(asksOwner ? 1 : 0);
    },
  );

  it.each(['bypassPermissions', 'auto', 'ask'])(
    'revokes the %s admission before execution and delayed delivery when live permissions change', async permissionMode => {
      const h = desktopFixture('automatic');
      let current = true;
      h.activeInput.permission = {
        permissionMode, planModeEnabled: false, isCurrent: () => current,
      };
      const queued = input();
      const decision = await h.authorize(call('set_session_runtime'));
      const syncGuard = await withToolCallAuthority(h.authorize, call('send_to_session'), async () => {
        bindTaskActionInput('target', queued);
        return captureTaskActionSyncGuard()!;
      });
      if (!decision.ok || !decision.run || typeof syncGuard !== 'function') throw new Error('Missing admission');
      current = false;
      const effect = vi.fn(async () => 'changed');
      await expect(decision.run(effect)).rejects.toThrow('AUTHORIZATION_EXPIRED');
      await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('AUTHORIZATION_EXPIRED');
      expect(() => syncGuard()).toThrow('AUTHORIZATION_EXPIRED');
      expect(effect).not.toHaveBeenCalled();
    },
  );

  // #6399, unit: the action-set loop cannot detect a missing tool. Invoke the
  // registered DirectToolSink handler: an automatic focus request must not reach
  // the Host callback that persists focus/resumes an idle Worker; owner input can.
  it('guards switch_focus through the registered Orca entry without adding an owner confirmation', async () => {
    const h = desktopFixture('automatic');
    const switchFocus = vi.fn(async () => ({ ok: true as const, workerId: 'worker' }));
    const unused = async (): Promise<never> => { throw new Error('Unexpected Orca operation'); };
    const server = createOrcaMcpServer(
      {
        authorizeCall: h.authorize, switchFocus,
        startTeam: unused, createWorker: unused, listWorkers: unused,
        sendToWorker: unused, interruptWorker: unused, listWorkerQueuedMessages: unused,
        updateWorkerQueuedMessage: unused, cancelWorkerQueuedMessage: unused,
        mergeWorkerQueuedMessages: unused, steerWorkerQueuedMessage: unused,
        moveWorkerQueuedMessage: unused, idleWorker: unused, endTeam: unused,
        archiveWorker: unused, listAvailableModels: unused, getWorkspaceInfo: unused,
        getWorkerStatus: unused, readWorker: unused,
      },
      { sessionId: 'companion', agentKind: 'codex', workingDir: '/tmp/test' },
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler(args: unknown): Promise<unknown> }>;
    })._registeredTools.switch_focus.handler;
    try {
      // An automatic focus request without a live runtime decision asks the owner instead of
      // failing silently; a refused card changes nothing.
      h.confirm.mockResolvedValueOnce(false);
      expect(await handler({ worker_id_or_label: 'worker' })).toMatchObject({ isError: true });
      expect(switchFocus).not.toHaveBeenCalled();
      h.activeInput.key = 'explicit-owner-request';
      h.activeInput.ownerInput = true;
      h.activeInput.automatic = false;
      expect(await handler({ worker_id_or_label: 'worker' })).not.toMatchObject({ isError: true });
      expect(switchFocus).toHaveBeenCalledExactlyOnceWith({
        leadSessionId: 'companion', workerIdOrLabel: 'worker',
      });
      expect(h.confirm).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  // #6399, unit: an async admission is not a transport preSend generation check.
  it.each(['input', 'account', 'group'] as const)('invalidates a captured synchronous guard on %s replacement', async change => {
    const h = desktopFixture(change === 'group' ? 'group' : 'private');
    let groupCurrent = true;
    if (change === 'group') releases.push(registerGroupToolAuthority('companion', {
      botId: 'bot', mode: 'owner', isCurrent: () => groupCurrent, validate: async () => {},
    }));
    const decision = await h.authorize(call('archive_sessions'));
    if (!decision.ok || !decision.run) throw new Error('Expected owner admission');
    const guard = await decision.run(async () => captureTaskActionSyncGuard()!);
    expect(() => guard()).not.toThrow();
    if (change === 'input') h.activeInput.key = 'replacement';
    if (change === 'account') hostFacts.boundaryPending.mockReturnValue(true);
    if (change === 'group') groupCurrent = false;
    expect(() => guard()).toThrow();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['private', 'group'] as const)(
    'accepts %s owner input without a second confirmation, including downstream authorization',
    async (kind) => {
      const h = desktopFixture(kind);
      const validate = vi.fn(async () => {});
      if (kind === 'group')
        releases.push(
          registerGroupToolAuthority('companion', {
            botId: 'bot',
            mode: 'owner',
            isCurrent: () => true,
            validate,
          }),
        );
      for (const [server, tool] of ownerWrites) {
        const result = await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server },
          async () => {
            expect(hasTaskActionAuthorization('companion')).toBe(true);
            if (tool === 'start_session_task')
              expect(approvedTaskDelegation('companion')).toMatchObject({ version: 1 });
            const queued = input();
            bindTaskActionInput('target', queued);
            await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
            return 'accepted';
          },
        );
        expect(result).toBe('accepted');
      }
      expect(h.confirm).not.toHaveBeenCalled();
      expect(hasTaskActionAuthorization('companion')).toBe(false);
      if (kind === 'group') expect(validate).toHaveBeenCalled();
    },
  );

  it.each(['chat', 'tools', 'missing', 'stale', 'other-bot', 'unavailable', 'revoked'] as const)(
    'rejects %s group authority before helper or Orca effects, without prompting',
    async (mode) => {
      const h = desktopFixture();
      h.activeInput.permission = {
        permissionMode: 'bypassPermissions', planModeEnabled: false, isCurrent: () => true,
      };
      if (mode !== 'missing')
        releases.push(
          registerGroupToolAuthority('companion', {
            botId: mode === 'other-bot' ? 'another' : 'bot',
            mode: mode === 'chat' || mode === 'tools' ? mode : 'owner',
            isCurrent: () => mode !== 'stale',
            validate: async () => {
              if (mode === 'unavailable') throw new GroupToolAuthorizationError(true);
              if (mode === 'revoked') throw new GroupToolAuthorizationError();
            },
          }),
        );
      const effect = vi.fn(async () => 'changed');
      for (const [server, tool] of ownerWrites)
        expect(
          await withToolCallAuthority(h.authorize, { ...call(tool), server }, effect),
        ).toMatchObject({ isError: true });
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it('keeps automatic input restricted to a live owner decision, not an unrelated group grant', async () => {
    const h = desktopFixture('automatic');
    releases.push(
      registerGroupToolAuthority('another-lane', {
        botId: 'bot',
        mode: 'owner',
        isCurrent: () => true,
        validate: async () => {},
      }),
    );
    const effect = vi.fn(async () => 'changed');
    h.confirm.mockResolvedValue(false);
    for (const [server, tool] of ownerWrites) {
      expect(
        await withToolCallAuthority(h.authorize, { ...call(tool), server }, effect),
      ).toMatchObject({ isError: true });
      expect(h.confirm).toHaveBeenCalledTimes(1);
      h.confirm.mockClear();
    }
    expect(
      await withToolCallAuthority(h.authorize, call('get_task_digest'), async () => 'observed'),
    ).toBe('observed');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('rechecks owner authority before execution and queued delivery without another confirmation', async () => {
    const h = desktopFixture();
    let live = true;
    releases.push(
      registerGroupToolAuthority('companion', {
        botId: 'bot',
        mode: 'owner',
        isCurrent: () => live,
        validate: async () => {},
      }),
    );
    const queued = input();
    await withToolCallAuthority(h.authorize, call('send_to_session'), async () =>
      bindTaskActionInput('target', queued),
    );
    const decision = await h.authorize(call('start_session_task'));
    if (!decision.ok || !decision.run) throw new Error('missing owner admission');
    live = false;
    const effect = vi.fn(async () => 'started');
    await expect(decision.run(effect)).rejects.toThrow();
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

// Review regressions: caller identity must not erase scoped delegation or mint it.
// Existing owner-input cases did not exercise automatic continuations. Unit tier.
describe('Existing execution authority', () => {
  it('keeps delegated work independent of follow-up enablement, but respects pause/revocation', async () => {
    const h = desktopFixture('automatic');
    const grant = {
      taskActionAuthority: { version: 1, actions: ['message_session_task', 'stop_session_task'] },
    };
    h.rows.delegation = {
      status: 'running',
      runSequence: 1,
      permissionSnapshotJson: JSON.stringify(grant),
    };
    for (const tool of ['message_session_task', 'stop_session_task']) {
      expect(await withToolCallAuthority(h.authorize, call(tool), async () => 'continued')).toBe(
        'continued',
      );
    }
    const queued = input();
    await withToolCallAuthority(h.authorize, call('message_session_task'), async () =>
      bindTaskActionInput('target', queued),
    );
    const pauseCall = { ...call('stop_session_task'), args: { task_id: 'task', mode: 'pause' } };
    const pauseDecision = await h.authorize(pauseCall);
    if (!pauseDecision.ok || !pauseDecision.run) throw new Error('Expected pause admission');
    const completingPause = await pauseDecision.run(async () => captureTaskActionGuard()!);
    h.rows.delegation.permissionSnapshotJson = JSON.stringify({
      ...grant,
      taskPause: { reason: 'owner' },
    });
    expect(await h.authorize(call('message_session_task'))).toMatchObject({ ok: false });
    expect(await h.authorize(pauseCall)).toMatchObject({ ok: false });
    await expect(completingPause()).resolves.toBeUndefined();
    h.rows.delegation = { ...h.rows.delegation, runSequence: 2 };
    await expect(completingPause()).rejects.toThrow('AUTHORIZATION_EXPIRED');
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('continues an ordinary Lead on a verified Worker report only within its active team', async () => {
    const h = desktopFixture('automatic');
    h.caller.botId = null;
    h.caller.source = 'desktop';
    h.activeInput.orcaSenderSessionId = 'worker-session';
    h.rows.team = { id: 'owned-active-team' };
    for (const tool of ['create_worker', 'send_to_worker', 'switch_focus', 'end_team']) {
      expect(
        await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server: 'cindy_orca' },
          async () => 'continued',
        ),
      ).toBe('continued');
    }
    expect(await h.authorize(call('send_to_session'))).toMatchObject({ ok: false });
    const decision = await h.authorize({ ...call('send_to_worker'), server: 'cindy_orca' });
    h.rows.team = null; // closed team or a sender not in this Lead's active team
    if (!decision.ok || !decision.run) throw new Error('missing scoped admission');
    const write = vi.fn(async () => 'changed');
    await expect(decision.run(write)).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(await h.authorize({ ...call('create_worker'), server: 'cindy_orca' })).toMatchObject({
      ok: false,
    });
    h.rows.team = { id: 'owned-active-team' };
    h.activeInput.orcaSenderSessionId = undefined; // scheduler/forwarded input, not a Worker report
    expect(await h.authorize({ ...call('create_worker'), server: 'cindy_orca' })).toMatchObject({
      ok: false,
    });
    expect(write).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

// Regression #6703: without a reusable runtime permission decision the owner saw an
// authorization error and no card, so there was nowhere to grant the action. Unit tier:
// the Desktop adapter, not the renderer, decides whether a card can be offered here.
describe('Desktop private-chat action confirmation', () => {
  it('offers one exact card and continues only after the owner approves it', async () => {
    const h = desktopFixture('automatic');
    const effect = vi.fn(async () => 'changed');
    h.confirm.mockResolvedValueOnce(false);
    const refused = await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain('USER_CANCELLED');
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith('companion', 'set_session_runtime', call().args);
    expect(effect).not.toHaveBeenCalled();
    // Approval authorizes this call only; a second call asks again.
    h.confirm.mockResolvedValueOnce(true);
    expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect)).toBe('changed');
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['plan-mode', (h: ReturnType<typeof desktopFixture>) => {
      h.activeInput.permission = { permissionMode: 'auto', planModeEnabled: true, isCurrent: () => true };
    }],
    ['plan-permission', (h: ReturnType<typeof desktopFixture>) => {
      h.activeInput.permission = { permissionMode: 'plan', planModeEnabled: false, isCurrent: () => true };
    }],
    ['stale-permission', (h: ReturnType<typeof desktopFixture>) => {
      h.activeInput.permission = { permissionMode: 'auto', planModeEnabled: false, isCurrent: () => false };
    }],
    ['shared-guest', (h: ReturnType<typeof desktopFixture>) => {
      h.caller.source = 'shared';
    }],
    ['task-lane', (h: ReturnType<typeof desktopFixture>) => {
      h.caller.role = 'delegation';
    }],
  ] as const)('keeps %s denials silent and closed', async (_state, arrange) => {
    const h = desktopFixture('automatic');
    arrange(h);
    const effect = vi.fn(async () => 'changed');
    expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect))
      .toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // Review gap on #6703: `permission == null` is exactly when the card is offered, so
  // "no snapshot" must not be read as "not Plan". The live Session Plan state decides.
  function setLivePlan(
    h: ReturnType<typeof desktopFixture>,
    plan: { enabled: boolean; generation: number } | null,
  ) {
    Object.defineProperty(h.runtime, 'stablePlanModeState', {
      value: plan, writable: true, configurable: true,
    });
  }

  it('still offers the card without a permission snapshot when the live Session is off Plan', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockResolvedValueOnce(true);
    const effect = vi.fn(async () => 'changed');
    expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect)).toBe('changed');
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith('companion', 'set_session_runtime', call().args);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['active', { enabled: true, generation: 2 }],
    ['unknown', null],
  ] as const)('keeps a %s Plan state silent when no reusable permission snapshot is available', async (_state, plan) => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, plan);
    const effect = vi.fn(async () => 'changed');
    const result = await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_REQUIRED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('drops the approval when Plan turns on while the card is open', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockImplementation(async () => {
      setLivePlan(h, { enabled: true, generation: 3 });
      return true;
    });
    const effect = vi.fn(async () => 'changed');
    const result = await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  // Review P1 on #6756: switching the permission tier into Plan advances only that tier's
  // generation and leaves the Plan generation untouched, so the Plan re-read above cannot
  // revoke the card. A tier still switching at answer time is not stable either, and any
  // other tier is a different tier than the one the owner answered for.
  it.each([
    ['a Plan tier', { mode: 'plan' as PermissionMode, generation: 3 }],
    ['no stable tier', null],
    ['another non-Plan tier', { mode: 'ask' as PermissionMode, generation: 2 }],
  ] as const)('drops the approval when the card is answered with %s', async (_state, tier) => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockImplementation(async () => {
      Object.assign(h.runtime, { stablePermissionModeState: tier });
      return true;
    });
    const effect = vi.fn(async () => 'changed');
    const result = await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it('also revokes an approved card delivery when the permission tier turns into Plan', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockResolvedValueOnce(true);
    const queued = input();
    expect(await withToolCallAuthority(h.authorize, call('send_to_session'), async () => {
      bindTaskActionInput('target', queued);
      return 'queued';
    })).toBe('queued');
    Object.assign(h.runtime, { stablePermissionModeState: { mode: 'plan', generation: 3 } });
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
  });

  // Review P2 on #6756: Auto→Ask in the same session advances only the permission tier's
  // generation; Plan state and the input boundary stay put, so the already-queued answer was
  // dispatched under a tier the owner never approved. The tier frozen at admission decides.
  it('revokes an approved card delivery when the permission tier changes without Plan', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockResolvedValueOnce(true);
    const queued = input();
    expect(await withToolCallAuthority(h.authorize, call('send_to_session'), async () => {
      bindTaskActionInput('target', queued);
      return 'queued';
    })).toBe('queued');
    Object.assign(h.runtime, { stablePermissionModeState: { mode: 'ask', generation: 2 } });
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
  });

  // The other half of the same rule: the comparison is by (mode, generation) value, so an
  // unchanged tier keeps both the execution and the queued delivery of the answer valid.
  it('keeps an approved card valid while the permission tier stays the same', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    h.confirm.mockImplementation(async () => {
      // A fresh object with the same mode and generation is still the frozen tier.
      Object.assign(h.runtime, { stablePermissionModeState: { mode: 'auto', generation: 1 } });
      return true;
    });
    const queued = input();
    expect(await withToolCallAuthority(h.authorize, call('send_to_session'), async () => {
      bindTaskActionInput('target', queued);
      return 'queued';
    })).toBe('queued');
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
  });

  // A tier that is still switching has no stable state to freeze, and the card is a yes/no
  // about one exact tier: without a frozen tier there is nothing to show or to approve.
  it('does not offer a card while the permission tier is switching', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    setLivePlan(h, { enabled: false, generation: 2 });
    Object.assign(h.runtime, { stablePermissionModeState: null });
    const effect = vi.fn(async () => 'changed');
    const result = await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_REQUIRED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // Review P2 on #6756: resume input re-reads the delegation row only for its grant, so a
  // pause (or a new run) written while the card was open survived as a frozen false boolean.
  const resumeCall = {
    ...call('message_session_task'),
    args: { task_id: 'task', mode: 'resume', message: 'continue' },
  };
  function pausableDelegation(h: ReturnType<typeof desktopFixture>) {
    const grant = { taskActionAuthority: { version: 1, actions: ['message_session_task'] } };
    h.rows.delegation = {
      status: 'running', runSequence: 1, permissionSnapshotJson: JSON.stringify(grant),
    };
    return grant;
  }
  const ownerPause = { token: 'pause-1', pausedAt: 1, previousStatus: 'running' };

  it('drops the resume approval when the owner pauses that delegation while the card is open', async () => {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    const grant = pausableDelegation(h);
    h.confirm.mockImplementation(async () => {
      h.rows.delegation!.permissionSnapshotJson = JSON.stringify({ ...grant, taskPause: ownerPause });
      return true;
    });
    const effect = vi.fn(async () => 'continued');
    const result = await withToolCallAuthority(h.authorize, resumeCall, effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['pause', 'new run'] as const)(
    'revokes an approved resume delivery when the delegation gets a %s first',
    async (change) => {
      const h = desktopFixture('automatic');
      h.activeInput.permission = null;
      const grant = pausableDelegation(h);
      h.confirm.mockResolvedValueOnce(true);
      const queued = input();
      expect(await withToolCallAuthority(h.authorize, resumeCall, async () => {
        bindTaskActionInput('target', queued);
        return 'continued';
      })).toBe('continued');
      // A real read returns a new row; never let the admission snapshot alias it.
      h.rows.delegation = change === 'pause'
        ? {
            ...h.rows.delegation!,
            permissionSnapshotJson: JSON.stringify({ ...grant, taskPause: ownerPause }),
          }
        : { ...h.rows.delegation!, runSequence: 2 };
      await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow(
        'AUTHORIZATION_EXPIRED',
      );
    },
  );

  it('does not offer a card for work the owner paused', async () => {
    const h = desktopFixture('automatic');
    h.rows.delegation = {
      status: 'running',
      runSequence: 1,
      permissionSnapshotJson: JSON.stringify({
        taskActionAuthority: { version: 1, actions: ['message_session_task'] },
        taskPause: { reason: 'owner' },
      }),
    };
    const effect = vi.fn(async () => 'continued');
    expect(await withToolCallAuthority(h.authorize, call('message_session_task'), effect))
      .toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });


  it('drops the approval when the turn boundary moves while the card is open', async () => {
    const h = desktopFixture('automatic');
    h.confirm.mockImplementation(async () => {
      h.activeInput.boundary = 'next-turn';
      return true;
    });
    const effect = vi.fn(async () => 'changed');
    expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect))
      .toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
  });
});

type CardRequest = { requestId: string; input?: unknown; [key: string]: unknown };
type CardBroadcast = { channel: string; payload: { sessionId?: string; request: CardRequest } };

function captureBroadcasts() {
  const cards: CardBroadcast[] = [];
  const bridge = new OrcaWorkerPermissionConfirmBridge({
    broadcast: (channel, payload) => {
      cards.push({ channel, payload: payload as CardBroadcast['payload'] });
    },
  });
  return { cards, bridge };
}

// #6703: the card is the only place a private-chat owner can authorize such an action, so the
// transport is covered against the real bridge register.ts publishes (not a `confirm` stub):
// one exact card per call, allow/deny/timeout mapping, and no cross-approval between calls.
describe('Task action confirmation card transport', () => {
  it.each([
    ['cindy_helper' as const, 'set_session_runtime', 'mcp__cindy_helper__set_session_runtime'],
    ['cindy_orca' as const, 'create_worker', 'mcp__cindy_orca__create_worker'],
  ])('names the exact %s tool the owner approves', (server, tool, toolName) => {
    const copy = taskActionConfirmationCopy(tool, { task_id: 'task', mode: 'auto' });
    expect(copy.action).toEqual({
      toolName, confirmation: 'task_action', input: { task_id: 'task', mode: 'auto' },
    });
    // Host copy, not an Agent label: both strings resolve from the locale bundle.
    expect(copy.title).toBeTruthy();
    expect(copy.title).not.toBe('taskActionConfirmation.title');
    expect(copy.description).not.toBe('taskActionConfirmation.once');
    expect(server).toBeTruthy();
  });

  it('uses the delegation wording only for starting a task', () => {
    expect(taskActionConfirmationCopy('start_session_task', {}).description)
      .not.toBe(taskActionConfirmationCopy('send_to_session', {}).description);
    expect(taskActionConfirmationCopy('start_session_task', {}).action.confirmation)
      .toBe('task_action');
  });

  function cardedFixture(bridge: OrcaWorkerPermissionConfirmBridge) {
    const h = desktopFixture('automatic');
    h.activeInput.permission = null;
    h.confirm.mockImplementation(async (sessionId: string, tool: string, args: unknown) =>
      (await bridge.request(sessionId, taskActionConfirmationCopy(tool, args))).confirmed);
    return h;
  }

  async function allowFromCard(cards: CardBroadcast[], index = 0) {
    await vi.waitFor(() => expect(cards.length).toBeGreaterThan(index));
    const card = cards[index]!;
    expect(card.channel).toBe(MAKER_PUSH.INTERACTION_REQUEST);
    const request = card.payload.request;
    expect(request).toMatchObject({
      kind: 'permission',
      metadata: { hostOwnedConfirmation: 'task_action' },
      toolName: 'mcp__cindy_helper__set_session_runtime',
    });
    expect(card.payload.sessionId).toBe('companion');
    return request;
  }

  it('continues the exact call only after the owner allows the card', async () => {
    const { cards, bridge } = captureBroadcasts();
    const h = cardedFixture(bridge);
    const effect = vi.fn(async () => 'changed');
    const pending = withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    const request = await allowFromCard(cards);
    // The picture on screen is the picture of this call, and it carries the Agent's arguments.
    expect(request.input).toEqual(call('set_session_runtime').args);
    expect(effect).not.toHaveBeenCalled();
    bridge.resolveFromIpc(
      request.requestId, { kind: 'permission', behavior: 'allow' },
      { isDeviceLink: false, assertTrustedSender: () => {} },
    );
    await expect(pending).resolves.toBe('changed');
    expect(effect).toHaveBeenCalledTimes(1);
    // Answered once: no card is left behind, and no follow-up card was offered.
    expect(bridge.pendingSnapshots()).toHaveLength(0);
    expect(cards.filter((card) => card.channel === MAKER_PUSH.INTERACTION_REQUEST)).toHaveLength(1);
  });

  it.each([
    ['denies', (bridge: OrcaWorkerPermissionConfirmBridge, requestId: string) => {
      bridge.resolveFromIpc(
        requestId, { kind: 'permission', behavior: 'deny' },
        { isDeviceLink: false, assertTrustedSender: () => {} },
      );
    }],
    ['times out', (bridge: OrcaWorkerPermissionConfirmBridge) => {
      void bridge; // the bridge's own timeout denies the call
    }],
  ] as const)('reports USER_CANCELLED when the owner %s the card', async (_state, answer) => {
    const cards: CardBroadcast[] = [];
    const bridge = new OrcaWorkerPermissionConfirmBridge({
      broadcast: (channel, payload) => {
      cards.push({ channel, payload: payload as CardBroadcast['payload'] });
    },
      timeoutMs: _state === 'times out' ? 5 : undefined,
    });
    const h = cardedFixture(bridge);
    const effect = vi.fn(async () => 'changed');
    const pending = withToolCallAuthority(h.authorize, call('set_session_runtime'), effect);
    const request = await allowFromCard(cards);
    answer(bridge, request.requestId);
    const result = await pending;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('USER_CANCELLED');
    expect(effect).not.toHaveBeenCalled();
  });

  it('never approves one call with the card of another', async () => {
    const { cards, bridge } = captureBroadcasts();
    const h = cardedFixture(bridge);
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    const firstPending = withToolCallAuthority(h.authorize, call('set_session_runtime'), first);
    const firstCard = await allowFromCard(cards);
    // A second concurrent automatic call while the card is open gets no card of its own.
    await expect(withToolCallAuthority(h.authorize, call('set_session_runtime'), second))
      .resolves.toMatchObject({ isError: true });
    expect(second).not.toHaveBeenCalled();
    bridge.resolveFromIpc(
      firstCard.requestId, { kind: 'permission', behavior: 'allow' },
      { isDeviceLink: false, assertTrustedSender: () => {} },
    );
    await expect(firstPending).resolves.toBe('first');
    expect(first).toHaveBeenCalledTimes(1);
  });
});


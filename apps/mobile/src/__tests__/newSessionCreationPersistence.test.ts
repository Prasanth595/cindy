import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '../auth/authOwnerGeneration';
import type { MobileMakerTransport } from '../device-link/mobileMakerTransport';
import type { DurableOutboxRecord } from '../session/durableOutbox';
import { cancelledCreationDraft, outboxCreationRetryIdentity } from '../session/cancelledCreationDraft';
import { buildOutboxItem } from '../session/sessionOutbox';

const disk = vi.hoisted(() => ({ data: new Map<string, string>(), fail: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...disk.data.keys()],
  getItem: async (key: string) => disk.data.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (disk.fail) throw new Error('disk unavailable');
    disk.data.set(key, value);
  },
  removeItem: async (key: string) => { disk.data.delete(key); },
} }));
vi.mock('../session/durableOutboxFiles', () => ({ durableOutboxUploadUri: vi.fn(), removeOutboxFiles: vi.fn() }));
vi.mock('../session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(7) }));
import { getCurrentMobileOutboxRecords, mobileDurableOutbox, persistCancelledCreationDraft } from '../session/mobileDurableOutbox';
import { completeNewSessionDurableEdit, getNewSessionCreationTask, hasLiveNewSessionCreation, holdNewSessionCreationDraft, prepareNewSessionCreationForEdit, restoreNewSessionDurableEdit, startNewSessionCreation } from '../session/newSessionCreation';
import { remoteSessionStore } from '../session/remoteSessionStore';
import { listPendingPrecreatedWorktrees, recoverPendingPrecreatedWorktrees, registerPendingPrecreatedWorktree } from '../session/precreatedWorktreeRecovery';
import { completePrecreatedWorktreeRecovery } from '../session/completePrecreatedWorktreeRecovery';

// Run the page's actual recovery -> durable save -> worktree creation statements.
// Extract AST nodes, as in newSessionWorktreeSync, so ordering is tested without
// duplicating the production pipeline or mounting unrelated native UI modules.
const source = ts.createSourceFile('new.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let statements: readonly ts.Statement[] | undefined;
function visit(node: ts.Node) {
  if (ts.isBlock(node) && node.statements.some((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(source) === 'previousRecovery'))) {
    const start = node.statements.findIndex((s) => ts.isVariableStatement(s)
      && s.declarationList.declarations.some((d) => d.name.getText(source) === 'previousRecovery'));
    const end = node.statements.findIndex((s) => ts.isBlock(s)
      && s.getText(source).includes('resolveSubmitGuardCatalog'));
    if (end < start) throw new Error('Missing page creation persistence boundary');
    statements = node.statements.slice(start, end);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!statements) throw new Error('Missing page creation pipeline');

beforeEach(async () => {
  setMobileAuthOwner(null);
  remoteSessionStore.clear();
  await mobileDurableOutbox.activate('');
  disk.data.clear();
  disk.fail = false;
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
});

function harness(previous: DurableOutboxRecord | null = null) {
  let sequence = 0;
  const draft = { agentKind: 'codex', workspaceKind: 'project', workingDir: '/repo', model: 'model',
    providerId: null, effort: 'high', permissionMode: 'ask', fastMode: false, firstMessage: 'keep my input' };
  const bindings = {
    effectiveDraft: { ...draft, ...previous?.creation?.draft },
    outboxRecoveryRef: { current: previous },
    getCurrentMobileOutboxRecords, mobileDurableOutbox, outboxCreationRetryIdentity, buildOutboxItem,
    selectedDeviceId: 'pc', selectedDeviceName: 'PC', authOwnerAtCreate: getMobileAuthOwner(),
    worktreeAccountId: 'alice', creatingWorktree: true,
    worktreeIntent: { applicable: true, enabled: true, eligibility: { status: 'eligible', baseRepo: '/repo' }, sourceBranch: 'main' },
    isCurrentOwner: () => true, ensureDeviceAlive: () => true, isWorktreeCreateIntentCurrent: () => true,
    createNewSessionId: () => `session-${++sequence}`, createOutboxClientId: () => 'message',
    runtimeOptions: { permissionOptions: [] }, prePlanPermissionModeRef: { current: null },
    planModeCapability: false, planModeDraftOn: false,
    holdNewSessionCreationDraft, holdPrecreatedWorktreeRegistration: () => () => {},
    sendAttachments: [{ id: 'photo', path: 'oss://photo', name: 'photo.png', ext: 'png', size: 3, category: 'image', mimeType: 'image/png' }],
    attachmentPreviews: {}, getUploadedSource: () => ({ uri: 'file:///photo.png' }),
    retainOutboxFile: vi.fn(async () => ({ slot: 0, fileName: 'slot-0.png', name: 'photo.png', size: 3, kind: 'image' })),
    removeRetainedOutboxFiles: vi.fn(async () => {}), releaseUploadedSources: vi.fn(),
    outboxAttachmentNeedsLocalBytes: () => true,
    registerPendingPrecreatedWorktree: vi.fn(async (..._args: Parameters<typeof registerPendingPrecreatedWorktree>) => true), forgetPendingPrecreatedWorktree: vi.fn(),
    buildWorktreeCreateRequest: (input: unknown) => input,
    parseWorktreeCreateResult: (input: unknown) => input,
    maker: { getSession: vi.fn(async () => null), worktree: {
      suggestName: vi.fn(async () => ({ name: 'new' })),
      create: vi.fn(async (): Promise<unknown> => ({ ok: true, meta: { path: '/repo/.cindy-worktrees/new' } })),
    } },
    t: (key: string) => key, setError: vi.fn(), setDraft: vi.fn(),
    formatRemoteError: (error: Error) => error.message,
    formatWorktreeCreateFailure: () => 'worktree failed',
  };
  const compiled = ts.transpileModule(`async function run(bindings) {
    let { ${Object.keys(bindings).join(', ')} } = bindings;
    let releaseDurableCreation, releasePrecreatedRegistration;
    try {
      ${statements!.map((node) => node.getText(source)).join('\n')}
      return { effectiveDraft, sessionId };
    } finally { releaseDurableCreation?.(); releasePrecreatedRegistration?.(); }
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function(`${compiled}; return run;`)() as (input: typeof bindings) => Promise<unknown>;
  return { bindings, run: () => run(bindings) };
}

it.each(['reservation-fails', 'create-rejected', 'reply-lost', 'leaves-during-create'] as const)(
  'keeps the latest restored draft reachable when resubmission stops before handoff: %s', async scenario => {
    await harness().run();
    const original = getCurrentMobileOutboxRecords()[0];
    const previous = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
    restoreNewSessionDurableEdit(previous);
    const leaveForm = completeNewSessionDurableEdit(previous.item.sessionId, previous.deviceId)!;
    const h = harness(previous);
    h.bindings.createNewSessionId = () => 'replacement-session';
    h.bindings.effectiveDraft.firstMessage = 'updated input before retry';
    if (scenario === 'reservation-fails') h.bindings.registerPendingPrecreatedWorktree.mockResolvedValueOnce(false);
    else if (scenario === 'create-rejected') h.bindings.maker.worktree.create.mockResolvedValueOnce({ ok: false, error: {} });
    else if (scenario === 'reply-lost') {
      h.bindings.registerPendingPrecreatedWorktree.mockImplementation(registerPendingPrecreatedWorktree);
      h.bindings.maker.worktree.create.mockRejectedValueOnce(new Error('reply lost'));
    } else {
      h.bindings.maker.worktree.create.mockImplementationOnce(async () => {
        leaveForm();
        expect(getNewSessionCreationTask('replacement-session')).toBeNull();
        expect(hasLiveNewSessionCreation('replacement-session')).toBe(true);
        expect(remoteSessionStore.getSessions()).toEqual([]);
        return { ok: false, error: {} };
      });
    }
    await h.run();
    if (scenario !== 'leaves-during-create') {
      // The claim follows record replacement, so an open editor keeps exclusivity.
      expect(getNewSessionCreationTask('replacement-session')).toBeNull();
      expect(remoteSessionStore.getSessions()).toEqual([]);
      leaveForm();
    }
    expect(h.bindings.setError).toHaveBeenCalledOnce();
    expect(getNewSessionCreationTask(previous.item.sessionId)).toBeNull();
    expect(getNewSessionCreationTask('replacement-session')).toMatchObject({ readyForEdit: 'durable',
      draft: { firstMessage: 'updated input before retry' }, attachments: [{ id: 'photo' }] });
    expect(remoteSessionStore.getSessions().map(row => row.id)).toEqual(['replacement-session']);
    expect(hasLiveNewSessionCreation('replacement-session')).toBe(false);

    if (scenario === 'reply-lost') {
      const result = await recoverPendingPrecreatedWorktrees(getMobileAuthOwner().accountId, {
        openLink: async () => {}, discardPrecreated: async () => ({ discarded: true }),
        cancelPrecreated: async () => ({ discarded: true }), isSessionClaimed: async () => false,
        shouldDefer: record => hasLiveNewSessionCreation(record.sessionId),
        onDiscarded: completePrecreatedWorktreeRecovery,
      });
      expect(result.recovered).toBe(1);
      expect(await listPendingPrecreatedWorktrees(getMobileAuthOwner().accountId)).toEqual([]);
    }

    // Only the replacement is persisted; a cold process can still restore its latest text and attachments.
    await mobileDurableOutbox.activate('');
    await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
    const saved = getCurrentMobileOutboxRecords()[0];
    expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
    expect(saved).toMatchObject({ storageSessionId: original.item.sessionId, suspended: true, state: 'failed',
      creation: { editReady: true, draft: { firstMessage: 'updated input before retry', workingDir: '/repo' } },
      item: { sessionId: 'replacement-session', clientId: original.item.clientId, attachmentSlots: [{ id: 'photo' }] },
      uploads: [{ fileName: 'slot-0.png' }] });
    expect(getNewSessionCreationTask('replacement-session')?.readyForEdit).toBe('durable');
    const leaveReopenedForm = completeNewSessionDurableEdit('replacement-session', 'pc');
    expect(getNewSessionCreationTask('replacement-session')).toBeNull();
    leaveReopenedForm!();
    expect(getNewSessionCreationTask('replacement-session')?.readyForEdit).toBe('durable');
  });

it.each(['switch-during-cleanup', 'suspend-fails'] as const)('persists the send fence before cleanup: %s', async scenario => {
  await harness().run();
  const saved = getCurrentMobileOutboxRecords()[0];
  const owner = getMobileAuthOwner();
  const recoveryKey = 'recovery-key-account-switch-1234';
  const ledger = { sessionId: saved.item.sessionId, deviceId: saved.deviceId,
    path: saved.creation!.draft.workingDir, recoveryKey, createdAt: Date.now(), phase: 'precreated' as const };
  await registerPendingPrecreatedWorktree(owner.accountId, ledger);
  let finishDiscard!: (ack: { discarded: true }) => void;
  const discard = vi.fn(() => {
    const persisted = [...disk.data.values()].map(raw => JSON.parse(raw))
      .find(value => value.item?.sessionId === saved.item.sessionId);
    expect(persisted.suspended).toBe(true);
    expect(persisted.creation.cancelled).toBeUndefined();
    return new Promise<{ discarded: true }>(resolve => { finishDiscard = resolve; });
  });
  startNewSessionCreation({
    sessionId: saved.item.sessionId, deviceId: saved.deviceId, deviceName: 'PC',
    draft: saved.creation!.draft, attachments: [], planModeArm: false, legacyPlanRestore: null,
    precreatedWorktree: { path: ledger.path, recoveryKey, originalWorkingDir: '/repo', createdAt: ledger.createdAt },
    precreatedWorktreeAccountId: owner.accountId,
    confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    authGateHint: 'not authenticated', onUnauthenticated: () => {},
    transport: { openLink: async () => {}, subscribe: async () => {},
      maker: { worktree: { discardPrecreated: discard } } as unknown as MobileMakerTransport },
  });
  await vi.waitFor(() => expect(getNewSessionCreationTask(saved.item.sessionId)?.status).toBe('create-failed'));
  if (scenario === 'suspend-fails') disk.fail = true;
  const pending = prepareNewSessionCreationForEdit(saved.item.sessionId);
  if (scenario === 'suspend-fails') {
    await expect(pending).rejects.toThrow('disk unavailable');
    expect(discard).not.toHaveBeenCalled();
    expect(getCurrentMobileOutboxRecords()[0].suspended).toBe(false);
    expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([ledger]);
    disk.fail = false;
    return;
  }
  await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
  setMobileAuthOwner('bob', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const bobRecord = { ...saved, accountId: getMobileAuthOwner().accountKey };
  await mobileDurableOutbox.add(bobRecord);
  const diskBeforeReply = new Map(disk.data);
  finishDiscard({ discarded: true });
  await expect(pending).resolves.toBeNull();
  expect(getNewSessionCreationTask(saved.item.sessionId)).toBeNull();
  expect(getCurrentMobileOutboxRecords()).toEqual([bobRecord]);
  expect(disk.data).toEqual(diskBeforeReply);
  expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([ledger]);

  // A cold reload after switching back must not make the old path sendable.
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, creation: { draft: saved.creation!.draft } });
  expect(getNewSessionCreationTask(saved.item.sessionId)).toBeNull();
  const result = await recoverPendingPrecreatedWorktrees(owner.accountId, {
    openLink: async () => {}, discardPrecreated: async () => ({ discarded: true }),
    cancelPrecreated: async () => ({ discarded: true }), isSessionClaimed: async () => false,
    shouldDefer: record => getNewSessionCreationTask(record.sessionId) !== null,
    onDiscarded: completePrecreatedWorktreeRecovery,
  });
  expect(result.recovered).toBe(1);
  expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([]);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, state: 'failed',
    creation: { cancelled: true, draft: { workingDir: '/repo' } }, item: saved.item, uploads: saved.uploads });
  expect(getNewSessionCreationTask(saved.item.sessionId)?.readyForEdit).toBe('durable');
});

it('persists the draft and attachments before reserving and dispatching worktree creation', async () => {
  const h = harness();
  h.bindings.registerPendingPrecreatedWorktree.mockImplementation(async () => {
    const saved = [...disk.data.values()].map((value) => JSON.parse(value) as DurableOutboxRecord)[0];
    expect(saved).toMatchObject({ suspended: true, item: { text: 'keep my input' },
      creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo' } },
      uploads: [{ fileName: 'slot-0.png' }] });
    return true;
  });
  await h.run();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledOnce();
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: false,
    creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
});

it('recovers the input after a lost create reply and cold outbox activation', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockRejectedValueOnce(new Error('reply lost'));
  await h.run();
  expect(h.bindings.setError).toHaveBeenCalledWith('session.new.worktreeCleanupPending');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, state: 'failed',
    item: { text: 'keep my input', attachmentSlots: [{ id: 'photo' }] }, uploads: [{ fileName: 'slot-0.png' }],
    creation: { cancelled: true, draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
});

it('does not reserve or dispatch a worktree if saving its draft fails', async () => {
  const h = harness();
  disk.fail = true;
  await expect(h.run()).rejects.toThrow('disk unavailable');
  expect(h.bindings.registerPendingPrecreatedWorktree).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(h.bindings.removeRetainedOutboxFiles).toHaveBeenCalledOnce();
});

it('keeps the original durable input when patching the successful worktree path fails', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockImplementationOnce(async () => {
    disk.fail = true;
    return { ok: true, meta: { path: '/repo/.cindy-worktrees/new' } };
  });
  await expect(h.run()).rejects.toThrow('disk unavailable');
  disk.fail = false;
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true,
    creation: { draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it.each([true, false])('reprobes a restored directory instead of submitting old eligibility (enabled=%s)', async (enabled) => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  Object.assign(h.bindings.worktreeIntent, { enabled, eligibility: { status: 'ineligible', reason: 'alreadyInWorktree' } });
  h.bindings.creatingWorktree = false;
  expect(await h.run()).toBeUndefined();
  expect(h.bindings.setDraft).toHaveBeenCalledOnce();
  const restored = h.bindings.setDraft.mock.calls[0][0](h.bindings.effectiveDraft);
  expect(restored).toMatchObject({ workingDir: '/repo', firstMessage: 'keep my input' });
  expect(h.bindings.maker.getSession).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it('retries a cancelled draft under one durable key and patches its new worktree path', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  const cancelled = await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(cancelled);
  h.bindings.createNewSessionId = () => 'retry-session';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ storageSessionId: 'session-1',
    item: { sessionId: 'retry-session', clientId: 'message' }, suspended: true,
    creation: { editReady: true, draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBeUndefined();
});

it.each([false, true])('transfers restored draft ownership before host creation (save fails: %s)', async saveFails => {
  await harness().run();
  const original = getCurrentMobileOutboxRecords()[0];
  const previous = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const leaveForm = completeNewSessionDurableEdit(previous.item.sessionId, previous.deviceId)!;
  const h = harness(previous);
  h.bindings.createNewSessionId = () => 'retry-handoff';
  await h.run();
  const record = getCurrentMobileOutboxRecords()[0];
  expect(record.suspended).toBe(true);
  expect(getNewSessionCreationTask('retry-handoff')).toBeNull();
  disk.fail = saveFails;
  const openLink = vi.fn(async () => {
    const saved = getCurrentMobileOutboxRecords()[0];
    expect(saved).toMatchObject({ suspended: false, state: 'queued' });
    expect(saved.creation?.editReady).toBeUndefined();
  });
  startNewSessionCreation({
    sessionId: record.item.sessionId, firstMessageClientId: record.item.clientId,
    deviceId: record.deviceId, deviceName: 'PC', draft: record.creation!.draft,
    attachments: [], planModeArm: false, legacyPlanRestore: null,
    confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    authGateHint: 'not authenticated', onUnauthenticated: () => {},
    transport: { openLink, subscribe: async () => {}, handoffFirstMessage: async () => {},
      maker: {} as MobileMakerTransport },
  });
  leaveForm();
  await vi.waitFor(() => expect(getNewSessionCreationTask('retry-handoff')?.status).toBe('create-failed'));
  expect(openLink).toHaveBeenCalledTimes(saveFails ? 0 : 1);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: saveFails, state: saveFails ? 'failed' : 'queued' });
  expect(getCurrentMobileOutboxRecords()[0].creation?.editReady).toBe(saveFails ? true : undefined);
  disk.fail = false;
  setMobileAuthOwner(null);
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  if (saveFails) expect(getNewSessionCreationTask('retry-handoff')?.readyForEdit).toBe('durable');
  else expect(getNewSessionCreationTask('retry-handoff')).toBeNull();
});

it('preserves a directory explicitly selected by the user while cancellation completes', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  h.bindings.effectiveDraft.workingDir = '/other-repo';
  h.bindings.worktreeIntent.eligibility.baseRepo = '/other-repo';
  h.bindings.createNewSessionId = () => 'user-retry';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledWith(expect.objectContaining({
    eligibility: expect.objectContaining({ baseRepo: '/other-repo' }),
  }));
  expect(getCurrentMobileOutboxRecords()[0].creation?.originalWorkingDir).toBe('/other-repo');
});

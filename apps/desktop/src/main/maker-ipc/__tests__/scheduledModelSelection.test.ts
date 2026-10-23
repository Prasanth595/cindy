import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { applyScheduledModelSelection, assertScheduledHarnessSupported, createScheduledModelScope, resolveScheduledModelSelection, ScheduledModelSelectionBusyError, type ScheduledModelSelection } from '../scheduledModelSelection';

const selection: ScheduledModelSelection = {
  agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: null, fastMode: false,
};

// User regression: an automation must not replace the next manually sent turn's
// model/provider/effort/Fast. Existing selection tests only covered applying the
// automation choice. Unit tier, including restart, failure and late cleanup.
describe('one-run automation model preferences', () => {
  function scopeFixture(
    effort: ScheduledModelSelection['effort'] | '' = 'high',
    fastMode: ScheduledModelSelection['fastMode'] = true,
  ) {
    const original: ScheduledModelSelection = {
      agentKind: 'codex', model: 'owner-model', providerId: 'owner-provider',
      effort: effort || null, fastMode,
    };
    let profile = { ...original, effort };
    let baseline: string | null = null;
    let id = 0;
    const deps = {
      createId: () => `scope-${++id}`,
      read: async () => ({ profile, baseline }),
      write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
      isBusy: vi.fn(() => false),
      apply: vi.fn(async (_id: string, value: ScheduledModelSelection) => {
        const { agentKind, model, providerId, effort, fastMode } = value;
        profile = { agentKind, model, providerId, effort, fastMode };
      }),
    };
    return { original, deps, scope: createScheduledModelScope(deps),
      automate: () => { profile = { ...selection }; },
      state: () => ({ profile, baseline }),
      choose: () => { baseline = null; profile = { ...original, model: 'new-owner-model' }; },
    };
  }
  it.each(['same-process', 'restart'])('restores all owner settings after %s', async (mode) => {
    const h = scopeFixture();
    await h.scope.begin('task');
    h.automate();
    const scope = mode === 'restart' ? createScheduledModelScope(h.deps) : h.scope;
    await scope.restore('task');
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  // PR #6559 + #6579 integration: the persisted scope must restore an
  // Ultrafast owner after automation/restart. Existing cases used booleans;
  // minimal failure is baseline JSON with fastMode='ultrafast'. Unit tier.
  it('restores an Ultrafast owner after automation and restart', async () => {
    const h = scopeFixture('high', 'ultrafast');
    const scopeId = await h.scope.begin('task');
    h.automate();
    const restarted = createScheduledModelScope(h.deps);
    expect(await restarted.begin('task')).toBe(scopeId);
    await restarted.restore('task', scopeId);
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  // PR #6579 P1: prior coverage only saved valid effort tiers. The scope must
  // restore a no-effort owner after automation, including persisted legacy ''.
  // Unit tier: exercise begin/restore with the raw session sentinel and reload.
  it.each(['new-save', 'legacy-restart'])('restores a no-effort owner after %s', async (mode) => {
    const h = scopeFixture('');
    const scopeId = await h.scope.begin('task');
    expect(JSON.parse(h.state().baseline!).effort).toBeNull();
    if (mode === 'legacy-restart') {
      await h.deps.write('task', { ...h.original, effort: '', scopeId });
    }
    h.automate();
    const scope = mode === 'legacy-restart' ? createScheduledModelScope(h.deps) : h.scope;
    // Queue preparation must retain the original owner even for legacy records.
    expect(await scope.begin('task')).toBe(scopeId);
    await scope.restore('task', scopeId);
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  it('retains the owner selection through a busy turn and a failed restore', async () => {
    const h = scopeFixture();
    await h.scope.begin('task');
    h.automate();
    h.deps.isBusy.mockReturnValue(true);
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(selection);
    expect(h.deps.apply).not.toHaveBeenCalled();
    h.deps.isBusy.mockReturnValue(false);
    h.deps.apply.mockRejectedValueOnce(new Error('offline'));
    await expect(h.scope.restore('task')).rejects.toThrow('offline');
    expect(JSON.parse(h.state().baseline!).model).toBe('owner-model');
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(h.original);
  });
  it('does not replace the saved owner choice when queue preparation enters the same run again', async () => {
    const h = scopeFixture();
    const id = await h.scope.begin('task');
    h.automate();
    expect(await h.scope.begin('task')).toBe(id);
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(h.original);
  });
  it('never lets late cleanup overwrite a newer explicit choice or another run', async () => {
    const h = scopeFixture();
    const old = await h.scope.begin('task');
    h.automate();
    h.choose();
    await h.scope.restore('task', old);
    expect(h.state().profile.model).toBe('new-owner-model');
    const current = await h.scope.begin('task');
    h.automate();
    await h.scope.restore('task', old);
    expect(h.state().profile).toEqual(selection);
    await h.scope.restore('task', current);
    expect(h.state().profile.model).toBe('new-owner-model');
  });
});
function fixture(agentKind: ScheduledModelSelection['agentKind'] = 'codex') {
  return {
    getTarget: vi.fn(async () => ({ agentKind, status: 'active' })),
    isBusy: vi.fn(() => false),
    resolveSelection: vi.fn(async (selection: ScheduledModelSelection) => selection),
    switchHarness: vi.fn(async (_selection: ScheduledModelSelection) => ({ engineReady: true })),
    applyModel: vi.fn(async (_selection: ScheduledModelSelection) => {}),
  };
}

describe('saved automation model selection at dispatch', () => {
  it('hands history to the target Harness before applying the complete model configuration', async () => {
    const deps = fixture();
    await applyScheduledModelSelection(selection, deps);
    expect(deps.switchHarness).toHaveBeenCalledWith(selection);
    expect(deps.applyModel).toHaveBeenCalledWith(selection);
    expect(deps.switchHarness.mock.invocationCallOrder[0]).toBeLessThan(deps.applyModel.mock.invocationCallOrder[0]);
  });
  it('uses the ordinary model path without a handoff for the same Harness', async () => {
    const deps = fixture('pi');
    await applyScheduledModelSelection(selection, deps);
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).toHaveBeenCalledWith(selection);
  });
  it('defers busy work without changing or staging either configuration', async () => {
    const deps = fixture();
    deps.isBusy.mockReturnValue(true);
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toBeInstanceOf(ScheduledModelSelectionBusyError);
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  // PR #6832: recovery must not depend on a dead target's catalog. The previous
  // fixture only resolved successfully, hiding offline/revoked-share failures.
  // Unit tier: unresolved saved preferences reach the runner without remote I/O.
  it.each(['missing', 'archived', 'deleted'])('preserves the saved choice for %s recovery without resolving the old catalog', async (status) => {
    const deps = fixture();
    deps.getTarget.mockResolvedValue(status === 'missing' ? null as never : { agentKind: 'codex', status });
    deps.resolveSelection.mockRejectedValue(new Error('old target offline or share revoked'));
    await expect(applyScheduledModelSelection(selection, deps)).resolves.toEqual(selection);
    expect(deps.resolveSelection).not.toHaveBeenCalled();
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  it('does not apply a model to a Harness that failed to become ready', async () => {
    const deps = fixture();
    deps.switchHarness.mockResolvedValue({ engineReady: false });
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('did not become ready');
    expect(deps.applyModel).not.toHaveBeenCalled();
  });

  it('resolves omitted effort before either the Harness switch or model application', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('custom')]));
    await applyScheduledModelSelection(selection, deps);
    const expected = { ...selection, effort: 'medium' };
    expect(deps.switchHarness).toHaveBeenCalledWith(expected);
    expect(deps.applyModel).toHaveBeenCalledWith(expected);
    expect(deps.resolveSelection.mock.invocationCallOrder[0]).toBeLessThan(deps.switchHarness.mock.invocationCallOrder[0]);
  });

  it('leaves the target untouched when the saved provider is unavailable', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('other')]));
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('unavailable');
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  it('clears stale Fast before switching Harness or applying the saved selection', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('custom')]));
    const expected = { ...selection, effort: 'medium', fastMode: false };
    await expect(applyScheduledModelSelection({ ...selection, providerId: null, fastMode: true }, deps))
      .resolves.toEqual(expected);
    expect(deps.switchHarness).toHaveBeenCalledWith(expected);
    expect(deps.applyModel).toHaveBeenCalledWith(expected);
  });
  it('rejects an unsupported bound Harness before route preparation or runtime mutation', async () => {
    const deps = { ...fixture(), getTarget: vi.fn(async () => ({
      agentKind: 'codex' as const, status: 'active', remoteHostId: 'ssh-host',
    })) };
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('current Harness');
    expect(deps.resolveSelection).not.toHaveBeenCalled();
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
});

function provider(id: string, model: Partial<CatalogModel> = {}): ProviderView {
  return {
    id, name: id, source: 'user', connected: true, agents: ['pi'],
    auth: { method: 'none' }, routing: { pi: {} },
    models: { pi: [{ id: 'test-model', name: 'Test model', contextWindow: 128_000,
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', ...model }] },
  } as ProviderView;
}

describe('saved effort uses the selected provider and Harness catalog copy', () => {
  it.each([null, 'ultra'] as const)('fills or reconciles %s to the route default', (effort) => {
    const selected = provider('custom', { efforts: ['low', 'high'], defaultEffort: 'high' });
    const other = provider('other', { efforts: ['low'], defaultEffort: 'low' });
    selected.models.codex = [{ ...selected.models.pi![0]!, efforts: ['medium'], defaultEffort: 'medium' }];
    expect(resolveScheduledModelSelection({ ...selection, effort }, [other, selected]))
      .toMatchObject({ agentKind: 'pi', providerId: 'custom', effort: 'high' });
  });
  it('preserves a supported explicit tier rather than replacing it with the default', () => {
    expect(resolveScheduledModelSelection({ ...selection, effort: 'low' }, [provider('custom')]).effort).toBe('low');
  });
  it('materializes the default provider before resolving its effort', () => {
    expect(resolveScheduledModelSelection({ ...selection, providerId: null }, [provider('custom')]))
      .toMatchObject({ providerId: 'custom', effort: 'medium' });
  });
  it('clears stale effort for a model with no adjustable tiers', () => {
    expect(resolveScheduledModelSelection({ ...selection, effort: 'high' }, [
      provider('custom', { efforts: [], defaultEffort: undefined }),
    ]).effort).toBeNull();
  });
  it.each([true, false, undefined])('uses only the selected route Fast capability (%s)', (supportsFastMode) => {
    const selected = provider('custom', { supportsFastMode });
    selected.models.codex = [{ ...selected.models.pi![0]!, supportsFastMode: true }];
    const providers = [provider('other', { supportsFastMode: true }), selected];
    expect(resolveScheduledModelSelection({ ...selection, fastMode: true }, providers).fastMode)
      .toBe(supportsFastMode === true);
    expect(resolveScheduledModelSelection(selection, providers).fastMode).toBe(false);
  });
});

describe('bound target Harness capability', () => {
  it.each([{ remoteHostId: 'ssh-host' }, { orcaRole: 'lead' }, { orcaRole: 'worker' }])(
    'rejects cross-Harness overrides on %j while preserving same-Harness and follow modes', (restriction) => {
      const target = { agentKind: 'codex' as const, status: 'active', ...restriction };
      expect(() => assertScheduledHarnessSupported(target, 'pi')).toThrow('current Harness');
      expect(() => assertScheduledHarnessSupported(target, 'codex')).not.toThrow();
      expect(() => assertScheduledHarnessSupported(target, undefined)).not.toThrow();
    },
  );
  it('preserves ordinary local cross-Harness selection and archived-target recovery', () => {
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'active' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'archived', remoteHostId: 'ssh-host' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported(null, 'pi')).not.toThrow();
  });
});

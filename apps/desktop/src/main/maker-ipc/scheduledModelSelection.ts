import type { AgentKind, Effort } from '@cindy/maker-core';
import { connectedProvidersForAgent, effectiveSourceIdForModel, findCatalogModel, isModelSelectableForNewRoute, type ProviderView } from '@cindy/model-providers';
import { resolveCompatibleSessionRuntimeEffort } from './sessionRuntimeControl';
import { parseScheduledModelBaseline, type ScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { throwIpcError } from '../utils/ipcValidate';

/** A saved automation choice, applied only while its target's send lock is held. */
export interface ScheduledModelSelection {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean | 'ultrafast';
}

export interface ScheduledModelSelectionLease {
  release: () => void;
  selection: ScheduledModelSelection;
}

/** Send-boundary operations only. The saved preference survives idle time and restart. */
export function createScheduledModelScope(deps: {
  read: (sessionId: string) => Promise<{
    profile: Omit<ScheduledModelSelection, 'effort'> & {
      effort: ScheduledModelSelection['effort'] | '';
    };
    baseline: string | null;
  } | null>;
  write: (sessionId: string, baseline: ScheduledModelBaseline | null, expectedBaseline: string | null) => Promise<void | boolean>;
  isBusy: (sessionId: string) => boolean;
  apply: (sessionId: string, profile: ScheduledModelSelection) => Promise<void>;
  createId: () => string;
  ownerEpoch?: () => string;
}) {
  const assertOwner = (owner: string | undefined) => {
    if (owner !== deps.ownerEpoch?.()) throw new Error('Account changed during scheduled model selection');
  };
  return {
    async begin(sessionId: string): Promise<string | undefined> {
      const owner = deps.ownerEpoch?.();
      const row = await deps.read(sessionId);
      assertOwner(owner);
      if (!row) return undefined;
      const existing = parseScheduledModelBaseline(row.baseline);
      if (existing) return existing.scopeId;
      const scopeId = deps.createId();
      const written = await deps.write(sessionId, { ...row.profile, effort: row.profile.effort || null, scopeId }, row.baseline);
      assertOwner(owner);
      if (written === false) throw new ScheduledModelSelectionBusyError('Scheduled model selection changed before scope creation');
      return scopeId;
    },
    async restore(sessionId: string, expectedScopeId?: string): Promise<void> {
      if (deps.isBusy(sessionId)) return;
      const owner = deps.ownerEpoch?.();
      const row = await deps.read(sessionId);
      assertOwner(owner);
      const baseline = parseScheduledModelBaseline(row?.baseline);
      if (!baseline || (expectedScopeId && baseline.scopeId !== expectedScopeId)) return;
      // A permanent save owns the next selection, including across restart.
      // Keep its old baseline for retries until reconciliation accepts the save.
      if (baseline.pendingBotProfileVersion) return;
      // Keep the saved choice on failure so the next input retries before dispatch.
      await deps.apply(sessionId, baseline);
      assertOwner(owner);
      const written = await deps.write(sessionId, null, row!.baseline);
      assertOwner(owner);
      if (written === false) throw new ScheduledModelSelectionBusyError('Scheduled model selection changed before scope cleanup');
    },
  };
}

export class ScheduledModelSelectionBusyError extends Error {}

interface ScheduledModelTarget {
  agentKind: AgentKind;
  status: string;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
}

/** Enforce the existing runtime boundary at save time as well as dispatch. */
export function assertScheduledHarnessSupported(
  target: ScheduledModelTarget | null,
  agentKind: AgentKind | undefined,
): void {
  if (target?.status !== 'active' || !agentKind || target.agentKind === agentKind) return;
  // Orca Lead/Worker use the ordinary handoff transaction, including restoration
  // before the next manual send. Only SSH still lacks cross-Harness handoff.
  if (target.remoteHostId) {
    throwIpcError('SSH_HARNESS_SWITCH_UNSUPPORTED', 'SSH automation targets must keep their current Harness');
  }
}

/** Saved selections may outlive catalog effort/Fast support; resolve the actual route first. */
export function resolveScheduledModelSelection(
  selection: ScheduledModelSelection,
  providers: ProviderView[],
): ScheduledModelSelection {
  const providerId = selection.providerId ??
    effectiveSourceIdForModel(providers, null, selection.model, selection.agentKind);
  const provider = connectedProvidersForAgent(providers, selection.agentKind)
    .find((candidate) => candidate.id === providerId);
  const model = findCatalogModel(provider, selection.model, selection.agentKind, { exact: true });
  if (!provider || !model ||
    !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
    throwIpcError('MODEL_SELECTION_UNAVAILABLE', `Scheduled model "${selection.model}" is unavailable from provider "${providerId ?? 'default'}"`);
  }
  return {
    ...selection,
    providerId,
    effort: resolveCompatibleSessionRuntimeEffort(model, selection.effort),
    fastMode: model.supportsFastMode === true && (selection.fastMode !== 'ultrafast' || (selection.agentKind === 'codex' && model.supportsUltrafastMode === true)) ? selection.fastMode : false,
  };
}

/** Resolve against the bound execution computer; the runner owns inactive-target recovery. */
export function createScheduledModelSelectionResolver(deps: {
  readRemoteProviders: (deviceId: string, agent: AgentKind, model: string, providerId: string | null) => Promise<ProviderView[]>;
  resolveLocalSelection: (selection: ScheduledModelSelection) => Promise<ScheduledModelSelection>;
}) {
  return async (selection: ScheduledModelSelection, target?: ScheduledModelTarget | null): Promise<ScheduledModelSelection> => {
    if (target?.agentDeviceId && !target.remoteHostId) {
      const providers = await deps.readRemoteProviders(
        target.agentDeviceId, selection.agentKind, selection.model, selection.providerId,
      );
      return resolveScheduledModelSelection(selection, providers);
    }
    return deps.resolveLocalSelection(selection);
  };
}

/** Reuse the ordinary history handoff; never stage an automation intent on a busy task. */
export async function applyScheduledModelSelection(
  selection: ScheduledModelSelection,
  deps: {
    getTarget: () => Promise<ScheduledModelTarget | null>;
    isBusy: () => boolean;
    resolveSelection: (selection: ScheduledModelSelection, target?: ScheduledModelTarget | null) => Promise<ScheduledModelSelection>;
    switchHarness: (selection: ScheduledModelSelection) => Promise<{ engineReady: boolean; retryPending?: boolean }>;
    applyModel: (selection: ScheduledModelSelection) => Promise<void>;
  },
): Promise<ScheduledModelSelection> {
  const target = await deps.getTarget();
  // The runner restores ordinary archived targets before selection and owns
  // deleted/missing-target rebinding for persistent tasks.
  // Its replacement resolves at the schedule's saved location. Do not query the old
  // target's catalog: that device may be offline or its provider share revoked.
  if (!target || target.status === 'archived' || target.status === 'deleted') {
    return selection;
  }
  if (deps.isBusy()) throw new ScheduledModelSelectionBusyError('Scheduled model selection waits for the current turn');
  assertScheduledHarnessSupported(target, selection.agentKind);
  // Automation changes model preferences within the bound task's execution location.
  // Persisted baselines from older clients have no location of their own.
  const resolved = await deps.resolveSelection(selection, target);
  if (target.agentKind !== resolved.agentKind) {
    const result = await deps.switchHarness(resolved);
    if (!result.engineReady || result.retryPending) throwIpcError('HARNESS_SWITCH_NOT_READY', 'Scheduled Harness switch did not become ready');
  }
  await deps.applyModel(resolved);
  return resolved;
}

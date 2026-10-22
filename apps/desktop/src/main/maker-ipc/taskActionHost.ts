import { and, eq } from 'drizzle-orm';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { Session } from '@cindy/maker-core';
import {
  botDelegations,
  botProfiles,
  botSessionLinks,
  sessions,
  orcaTeams,
  orcaWorkers,
} from '../localDb/schema.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { authorizeGroupTool } from './botGroupToolAuthorization.js';
import type { FsSessionSnapshotUnavailable } from './ghostFsSessionSnapshot.js';
import {
  admitTaskAction,
  createTaskActionAuthorizer,
  DELEGATED_TASK_ACTIONS,
  taskActionFingerprint,
  type TaskActionScope,
} from './taskActionAuthorization.js';

type TaskActionSession = Pick<Session,
  'stablePermissionModeState' | 'stablePlanModeState' |
  'getCurrentTurnOrigin' | 'reviewHostPermissionAction'>;

/** The live turn identifies a continuation, not consent. Only its existing
 * permission reviewer may approve the exact action against restored user intent. */
function captureScheduledRuntime(
  sessionId: string,
  getSession: (id: string) => TaskActionSession | undefined,
) {
  const session = getSession(sessionId);
  const origin = session?.getCurrentTurnOrigin();
  if (!session || origin?.kind !== 'scheduler') return null;
  const permissionState = session.stablePermissionModeState;
  const planState = session.stablePlanModeState;
  if (!permissionState || !planState || planState.enabled || permissionState.mode === 'plan') return null;
  const permission = { ...permissionState };
  const plan = { ...planState };
  const assertCurrent = () => {
    const currentPermission = session.stablePermissionModeState;
    const currentPlan = session.stablePlanModeState;
    if (getSession(sessionId) !== session || !currentPermission || !currentPlan ||
      currentPermission.generation !== permission.generation ||
      currentPermission.mode !== permission.mode || currentPlan.enabled ||
      currentPlan.generation !== plan.generation) {
      throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
    }
  };
  return {
    session,
    assertCurrent,
    assertInputCurrent() {
      assertCurrent();
      if (session.getCurrentTurnOrigin() !== origin) {
        throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      }
    },
  };
}

/** The one waiting request an answer would be submitted to, exactly as the row records it. */
function readPendingRequestId(row: { pendingInteractionJson: string | null } | null): string | null {
  if (!row?.pendingInteractionJson) return null;
  try {
    const parsed = JSON.parse(row.pendingInteractionJson) as { requestId?: unknown };
    return typeof parsed.requestId === 'string' ? parsed.requestId : null;
  } catch {
    return null;
  }
}

/** Adapt the shared gate to Host facts. No transcript parsing or Agent-supplied approval fields. */
export function createDesktopTaskActionAuthorizer(deps: {
  input(sessionId: string): {
    key: string;
    ownerInput: boolean;
    automatic?: boolean;
    orcaSenderSessionId?: string;
    /** Live runtime facts only; never persisted preferences or tool arguments. */
    permission?: {
      permissionMode: string;
      planModeEnabled?: boolean;
      isCurrent?: () => boolean;
    } | null;
    /** Explicit Host fact: there is no reusable permission decision, and why. */
    permissionUnavailable?: FsSessionSnapshotUnavailable | null;
    boundary: string;
  };
  getSession(sessionId: string): TaskActionSession | undefined;
  confirm(sessionId: string, tool: string, args: unknown): Promise<boolean>;
}): ToolCallAuthorizer {
  return async (call) => {
    // Per invocation: a concurrent automatic call must never inherit owner evidence.
    let admittedScope: TaskActionScope | null = null;
    let rejectedDecision: Awaited<ReturnType<ToolCallAuthorizer>> | null = null;
    const fingerprint = taskActionFingerprint(call);
    const decision = await createTaskActionAuthorizer({
      confirm: deps.confirm,
      capture: async (call) => {
        if (!call.sessionId) throw new Error('TASK_UNAVAILABLE');
        const sessionId = call.sessionId;
        const db = tryGetDbClient();
        if (!db || isAppSessionBoundaryPending()) throw new Error('HOST_NOT_READY');
        const [caller] = await db.drizzle
          .select({
            source: sessions.source,
            clearedAt: sessions.clearedAt,
            botId: botSessionLinks.botId,
            role: botSessionLinks.role,
            botStatus: botProfiles.status,
            archivedAt: botSessionLinks.archivedAt,
          })
          .from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!caller) throw new Error('TASK_UNAVAILABLE');
        const input = deps.input(sessionId);
        const scheduled = !caller.botId && caller.source !== 'bot' &&
          deps.getSession(sessionId)?.getCurrentTurnOrigin()?.kind === 'scheduler';
        // User-authored ordinary work retains the existing Agent permission flow.
        if (
          !caller.botId &&
          caller.source !== 'bot' &&
          caller.source !== 'scheduler' &&
          !input.automatic && !scheduled
        )
          return null;
        if (caller.botId && (caller.botStatus !== 'active' || caller.archivedAt !== null))
          throw new Error('BOT_SESSION_INACTIVE');
        // A persisted group lane is not consent. Reuse Chat Server's live, owner-only
        // execution authority; guest, stale and temporarily unavailable grants fail closed.
        const group =
          caller.botId && caller.role === 'group'
            ? await authorizeGroupTool(sessionId, caller.botId, 'owner-action')
            : null;
        const ownerInput = group !== null || input.ownerInput;
        // All execution modes use the normal runtime permission flow, including
        // automatic/resumed turns. Do not ask for owner consent a second time.
        // Group identity was checked above; shared guests keep their own boundary.
        // This is the Host admission snapshot, not an upstream approval receipt.
        // Its revocation lifetime starts here; the approval-to-Host handoff keeps
        // ordinary session semantics and is not made atomic by this gate.
        const permission = input.permission;
        // The confirmation card below exists exactly when no reusable permission snapshot
        // is available, so Plan cannot be ruled out from that absent snapshot ("no
        // snapshot" is not "not Plan"). Read the live Session state instead — the same
        // authority `captureScheduledRuntime` and the permission reviewer use.
        const livePlan = permission == null
          ? deps.getSession(sessionId)?.stablePlanModeState
          : null;
        const planPermitsOwnerCard = permission == null
          ? livePlan?.enabled === false
          : permission.permissionMode !== 'plan' && permission.planModeEnabled !== true;
        const runtimePermissionApplies = caller.source !== 'shared'
          && ['bypassPermissions', 'auto', 'ask', 'default', 'acceptEdits'].includes(permission?.permissionMode ?? '')
          && permission != null
          && permission.planModeEnabled === false
          && permission.isCurrent?.() === true;
        const useRuntimePermissions = ownerInput || runtimePermissionApplies;
        // Without a reusable runtime permission decision the agent otherwise gets a bare
        // "authorization required" with nowhere to grant it. Only the owner's own private
        // lane has a live owner to ask: Plan never authorizes side effects, a snapshot we
        // already know changed is not re-usable, and shared guests answer for someone else.
        const cardOwnerLane = caller.source !== 'shared'
          && !!caller.botId
          && (caller.role === 'canonical' || caller.role === 'thread')
          && planPermitsOwnerCard
          && (permission == null || permission.isCurrent?.() === true);
        // A card answers one exact action under the permission tier the owner was shown, so
        // that stable tier is frozen here, when the decision is formed, and not re-derived
        // from whatever happens to be live at delivery: Auto→Ask advances only this tier's
        // generation while Plan state and the input boundary stay put. A tier still switching
        // has no stable state to freeze, and Plan itself never authorizes side effects, so
        // without a frozen non-Plan tier there is no tier to compare later.
        const frozenCardSource = !useRuntimePermissions && cardOwnerLane
          ? deps.getSession(sessionId)?.stablePermissionModeState
          : null;
        const frozenCardTier = frozenCardSource
          ? { mode: frozenCardSource.mode, generation: frozenCardSource.generation }
          : null;
        // Without a reusable decision the card rests on the Host fact the input read carried,
        // not on a second guess at the live states: only a tier change still committed in
        // flight — active Session, Plan settled and known off — can put a yes/no in front of
        // the owner. A closing or absent Session and an unknown Plan state stay silent, so
        // "no snapshot" is never by itself enough to ask.
        const ownerConfirmable = cardOwnerLane && (frozenCardTier
          ? frozenCardTier.mode !== 'plan'
          : input.permissionUnavailable === 'permission-switching');
        const assertPermissionCurrent = () => {
          if (runtimePermissionApplies && permission?.isCurrent?.() !== true)
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          // A card is only ever offered off Plan and is never a reusable permission decision.
          // Both the execution and the queued delivery of that answer re-check the tier frozen
          // at admission, so Auto→Ask — which advances only this generation and leaves Plan
          // state and the input boundary untouched — revokes it. A card admitted while the
          // tier change was still in flight has no tier to compare (the owner answered for one
          // exact action, not for a tier): it requires the Session to have settled on some
          // stable non-Plan tier, and Plan or an unavailable tier still revokes it.
          if (!useRuntimePermissions && cardOwnerLane) {
            const live = deps.getSession(sessionId);
            const currentPermission = live?.stablePermissionModeState;
            const currentPlan = live?.stablePlanModeState;
            const planStillOff = livePlan
              ? currentPlan?.enabled === false && currentPlan.generation === livePlan.generation
              : currentPlan?.enabled === false;
            const tierStillCurrent = frozenCardTier
              ? currentPermission != null &&
                currentPermission.mode === frozenCardTier.mode &&
                currentPermission.generation === frozenCardTier.generation
              : currentPermission != null && currentPermission.mode !== 'plan';
            if (!tierStillCurrent || !planStillOff)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
        };
        // Retain scheduled-review recovery only when no live runtime decision can
        // be reused. A current permission flow must never be reviewed twice.
        const runtime = !useRuntimePermissions && scheduled
          ? captureScheduledRuntime(sessionId, deps.getSession)
          : null;
        const args =
          call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
        /** The owner paused this work on purpose: no card may reopen it. */
        let delegationPaused = false;
        /** The one delegation row this call acts on, before any grant/pause interpretation. */
        const readDelegationRow = async () => {
          if (
            !taskId ||
            !DELEGATED_TASK_ACTIONS.includes(call.tool as (typeof DELEGATED_TASK_ACTIONS)[number])
          )
            return null;
          const [row] = await db.drizzle
            .select()
            .from(botDelegations)
            .where(
              and(eq(botDelegations.id, taskId), eq(botDelegations.parentSessionId, sessionId)),
            )
            .limit(1);
          return row ?? null;
        };
        const readDelegationSnapshot = (row: { permissionSnapshotJson: string }) => {
          try {
            return JSON.parse(row.permissionSnapshotJson) as {
              taskActionAuthority?: { version?: number; actions?: string[] };
              taskPause?: unknown;
            };
          } catch {
            return null;
          }
        };
        const readDelegation = async (
          row: Awaited<ReturnType<typeof readDelegationRow>>,
          rechecking = false,
        ) => {
          if (!row || !['queued', 'running', 'waiting'].includes(row.status)) return null;
          const snapshot = readDelegationSnapshot(row);
          if (!snapshot) return null;
          const grant = snapshot.taskActionAuthority;
          // Paused work only resumes following a new owner request. Permission answers
          // and model changes are also exact decisions, never a standing message grant.
          // An admitted pause writes its intent before stopping the execution.
          // That intent cannot revoke the very same stop; it still blocks every
          // new admission and every message/resume delivery.
          const completingPause = rechecking && call.tool === 'stop_session_task' && args.mode === 'pause';
          if (rechecking === false && snapshot.taskPause && !completingPause) delegationPaused = true;
          if ((snapshot.taskPause && !completingPause) || args.decision || args.answers || args.mode === 'resume')
            return null;
          return grant?.version === 1 && grant.actions?.includes(call.tool) ? row : null;
        };
        // The row itself is delivery evidence: a reused grant is not the only authority a
        // card rests on, and pausing or reopening that run must revoke the answer either way.
        const delegationRow = useRuntimePermissions ? null : await readDelegationRow();
        const delegation = useRuntimePermissions ? null : await readDelegation(delegationRow);
        // An answer card is answered by delegation, not by request: `reply()` submits the
        // yes/no or the answers to whichever request that one task is waiting on when the
        // card is consumed. Freeze the request the owner was shown, so a request already
        // settled elsewhere (the task's own window, another device, a timeout) can never be
        // answered by an older card for the next one — that swap moves neither the input
        // boundary nor `runSequence` nor the pause intent. `mode=resume` never answers a
        // request, so it keeps its own pause/run recheck and freezes nothing here.
        const answersWaitingRequest = !useRuntimePermissions && cardOwnerLane
          && call.tool === 'message_session_task'
          && args.mode !== 'resume'
          && !!(args.decision || args.answers);
        const frozenPendingRequestId = answersWaitingRequest
          ? readPendingRequestId(delegationRow)
          : undefined;
        // A real Worker report continues its ordinary Lead's existing team. It
        // cannot authorize helper writes to unrelated tasks or create a new team.
        const readOrcaTeam = async () => {
          if (
            caller.botId ||
            caller.source === 'bot' ||
            caller.source === 'scheduler' ||
            call.server !== 'cindy_orca' ||
            !input.orcaSenderSessionId
          )
            return null;
          const [team] = await db.drizzle
            .select({ id: orcaTeams.id })
            .from(orcaTeams)
            .innerJoin(orcaWorkers, eq(orcaWorkers.teamId, orcaTeams.id))
            .where(
              and(
                eq(orcaTeams.leadSessionId, sessionId),
                eq(orcaTeams.status, 'active'),
                eq(orcaWorkers.sessionId, input.orcaSenderSessionId),
              ),
            )
            .limit(1);
          return team ?? null;
        };
        const orcaTeam = useRuntimePermissions ? null : await readOrcaTeam();
        const assertDeliveryCurrent = async () => {
          runtime?.assertCurrent();
          await group?.refresh();
          if (
            isAppSessionBoundaryPending() ||
            db !== tryGetDbClient() ||
            deps.input(sessionId).boundary !== input.boundary
          )
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          const [fresh] = await db.drizzle
            .select({
              status: sessions.status,
              clearedAt: sessions.clearedAt,
              botStatus: botProfiles.status,
              archivedAt: botSessionLinks.archivedAt,
            })
            .from(sessions)
            .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
            .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (
            !fresh ||
            fresh.status === 'deleted' ||
            fresh.clearedAt !== caller.clearedAt ||
            (caller.botId && (fresh.botStatus !== 'active' || fresh.archivedAt !== null))
          )
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          if (delegationRow) {
            const currentRow = await readDelegationRow();
            if (!currentRow || currentRow.runSequence !== delegationRow.runSequence)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            // The request the owner answered for is part of this evidence. The same task
            // asking something else — or nothing — is a different answer, and this is the
            // one recheck both consumption points pass through: execution
            // (`admitTaskAction.run()`) and queued delivery, plus `reply()`'s own refresh
            // before it resolves the interaction.
            if (frozenPendingRequestId !== undefined &&
              readPendingRequestId(currentRow) !== frozenPendingRequestId)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            if (delegation) {
              if (!(await readDelegation(currentRow, true)))
                throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            } else {
              // A card reuses no grant, but the same row's pause intent still governs it.
              const completingPause =
                call.tool === 'stop_session_task' && args.mode === 'pause';
              if (readDelegationSnapshot(currentRow)?.taskPause && !completingPause)
                throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            }
          }
          if (orcaTeam) {
            if ((await readOrcaTeam())?.id !== orcaTeam.id)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          group?.assertCurrent();
          // Queued delivery and execution share this one stable-tier recheck, so an answer can
          // never be dispatched under a tier other than the one frozen at admission.
          assertPermissionCurrent();
          if (db !== tryGetDbClient() || isAppSessionBoundaryPending())
            throw new Error('OWNER_SCOPE_CHANGED');
          runtime?.assertCurrent();
        };
        const assertCurrentSync = () => {
          runtime?.assertInputCurrent();
          group?.assertCurrent();
          assertPermissionCurrent();
          const current = deps.input(sessionId);
          if (
            isAppSessionBoundaryPending() || db !== tryGetDbClient() ||
            current.boundary !== input.boundary || current.key !== input.key
          ) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
        };
        const scope: TaskActionScope = {
          key: input.key,
          ownerInput,
          ownerConfirmable: ownerConfirmable && !delegationPaused,
          delegated: !!delegation || !!orcaTeam,
          assertDeliveryCurrent,
          assertCurrentSync,
          assertCurrent: async () => {
            if (fingerprint !== taskActionFingerprint(call))
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            await assertDeliveryCurrent();
            assertCurrentSync();
          },
        };
        if (useRuntimePermissions) {
          // Owner requests and live execution modes use the normal Agent permission flow.
          // Retain delivery evidence so workbench, queues and new delegations work too.
          admittedScope = scope;
          return null;
        }
        if (runtime && !scope.delegated) {
          // Session reuses Full Access / Auto / Ask and the owning task's restored
          // user intent. Do not turn scheduled text into a fresh owner request.
          const review = await runtime.session.reviewHostPermissionAction({
            kind: 'other',
            description: JSON.stringify({
              toolName: `mcp__${call.server}__${call.tool}`,
              input: structuredClone(call.args),
              // Host timing fact, not a grant: setup may have asked to wait
              // for a trigger which has now occurred. Owner scope still applies.
              context: { source: 'scheduler', phase: 'triggered-continuation' },
            }),
          });
          // A stale review must not open a confirmation for a newer task/input.
          const admission = await admitTaskAction(call, scope, fingerprint);
          if (!admission.ok) {
            rejectedDecision = admission;
            return null;
          }
          if (review.verdict === 'allow' || (review.verdict === 'ask' &&
            await deps.confirm(sessionId, call.tool, structuredClone(call.args)))) {
            admittedScope = scope;
            return null;
          }
        }
        return scope;
      },
    })(call);
    return rejectedDecision ?? (decision.ok && admittedScope
      ? admitTaskAction(call, admittedScope, fingerprint) : decision);
  };
}

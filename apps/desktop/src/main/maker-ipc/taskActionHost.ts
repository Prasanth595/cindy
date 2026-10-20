import { and, eq } from 'drizzle-orm';
import type { ToolCallAuthorizer } from '@cindy/mcps';
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
import {
  admitTaskAction,
  createTaskActionAuthorizer,
  DELEGATED_TASK_ACTIONS,
  type TaskActionScope,
} from './taskActionAuthorization.js';

/** Adapt the shared gate to Host facts. No transcript parsing or Agent-supplied approval fields. */
export function createDesktopTaskActionAuthorizer(deps: {
  input(sessionId: string): {
    key: string;
    ownerInput: boolean;
    automatic?: boolean;
    orcaSenderSessionId?: string;
    boundary: string;
  };
  confirm(sessionId: string, tool: string, args: unknown): Promise<boolean>;
}): ToolCallAuthorizer {
  return async (call) => {
    // Per invocation: a concurrent automatic call must never inherit owner evidence.
    let ownerScope: TaskActionScope | null = null;
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
        // User-authored ordinary work retains the existing Agent permission flow.
        if (
          !caller.botId &&
          caller.source !== 'bot' &&
          caller.source !== 'scheduler' &&
          !input.automatic
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
        const args =
          call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
        const readDelegation = async (rechecking = false) => {
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
          if (!row || !['queued', 'running', 'waiting'].includes(row.status)) return null;
          let snapshot: {
            taskActionAuthority?: { version?: number; actions?: string[] };
            taskPause?: unknown;
          };
          try {
            snapshot = JSON.parse(row.permissionSnapshotJson);
          } catch {
            return null;
          }
          const grant = snapshot.taskActionAuthority;
          // Paused work only resumes following a new owner request. Permission answers
          // and model changes are also exact decisions, never a standing message grant.
          // An admitted pause writes its intent before stopping the execution.
          // That intent cannot revoke the very same stop; it still blocks every
          // new admission and every message/resume delivery.
          const completingPause = rechecking && call.tool === 'stop_session_task' && args.mode === 'pause';
          if ((snapshot.taskPause && !completingPause) || args.decision || args.answers || args.mode === 'resume')
            return null;
          return grant?.version === 1 && grant.actions?.includes(call.tool) ? row : null;
        };
        const delegation = ownerInput ? null : await readDelegation();
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
        const orcaTeam = ownerInput ? null : await readOrcaTeam();
        const assertDeliveryCurrent = async () => {
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
          if (delegation) {
            const current = await readDelegation(true);
            if (!current || current.runSequence !== delegation.runSequence)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          if (orcaTeam) {
            if ((await readOrcaTeam())?.id !== orcaTeam.id)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          group?.assertCurrent();
          if (db !== tryGetDbClient() || isAppSessionBoundaryPending())
            throw new Error('OWNER_SCOPE_CHANGED');
        };
        const assertCurrentSync = () => {
          group?.assertCurrent();
          const current = deps.input(sessionId);
          if (
            isAppSessionBoundaryPending() || db !== tryGetDbClient() ||
            current.boundary !== input.boundary || current.key !== input.key
          ) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
        };
        const scope: TaskActionScope = {
          key: input.key,
          ownerInput,
          delegated: !!delegation || !!orcaTeam,
          assertDeliveryCurrent,
          assertCurrentSync,
          assertCurrent: async () => {
            await assertDeliveryCurrent();
            assertCurrentSync();
          },
        };
        if (ownerInput) {
          // Owner requests use the normal Agent permission flow, without a second card.
          // Retain delivery evidence so workbench, queues and new delegations work too.
          ownerScope = scope;
          return null;
        }
        return scope;
      },
    })(call);
    return decision.ok && ownerScope ? admitTaskAction(call, ownerScope) : decision;
  };
}

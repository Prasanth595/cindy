import type { Session } from '@cindy/maker-core';
import type { FsSessionSnapshot } from '../cindy-brain/fsSlot.js';

/**
 * Why the live Session offered no reusable permission decision, read from that same Session
 * (#6703 / #6756). A null snapshot is not "no permission": Host callers that would otherwise
 * answer the Agent with a bare `TASK_ACTION_AUTHORIZATION_REQUIRED` must be able to tell the
 * owner's momentary tier switch apart from a closed Session or an unknown Plan state.
 */
export type FsSessionSnapshotUnavailable =
  /** This Host process holds no live Session for the task. */
  | 'no-live-session'
  /** The Session is closing: there is no boundary left to reuse. */
  | 'session-closing'
  /** Plan is switching, unknown, or the Session is terminating: Plan cannot be ruled out. */
  | 'plan-state-unavailable'
  /** Active and settled off Plan; only the permission tier change is still in flight. */
  | 'permission-switching';

/** Companion to `resolveGhostFsSessionSnapshot`: never read the Session twice for one call. */
export function describeFsSessionSnapshotUnavailable(
  session: Session | undefined,
): FsSessionSnapshotUnavailable | null {
  if (!session) return 'no-live-session';
  const plan = session.stablePlanModeState;
  if (plan && session.stablePermissionModeState) return null;
  if (session.getStatus() !== 'active') return 'session-closing';
  // A readable Plan state proves this Session is active, not terminating and settled on
  // Plan, so a missing tier can then only be a permission change still committed in flight.
  return plan ? 'permission-switching' : 'plan-state-unavailable';
}

/** Only live Session authority can authorize a plugin's workdir write, never the DB mirror. */
export function resolveGhostFsSessionSnapshot(
  getSession: (sessionId: string) => Session | undefined,
  sessionId: string,
  instanceId?: string,
): FsSessionSnapshot | null {
  const session = getSession(sessionId);
  if (!instanceId || !session || session.instanceId !== instanceId) return null;
  const permission = session.stablePermissionModeState;
  const plan = session.stablePlanModeState;
  if (!permission || !plan) return null;
  const workDir = session.workDir;
  const isCurrent = () => {
    const currentPlan = session.stablePlanModeState;
    return getSession(sessionId) === session
      && session.workDir === workDir
      && session.stablePermissionModeState?.generation === permission.generation
      && currentPlan?.generation === plan.generation
      && currentPlan.enabled === plan.enabled;
  };
  return {
    workingDir: workDir,
    remoteHostId: session.remoteHostId,
    permissionMode: permission.mode ?? 'ask',
    planModeEnabled: plan.enabled,
    isCurrent,
    reviewAction: async (action) => {
      const decision = await session.reviewHostPermissionAction(action);
      return isCurrent()
        ? decision
        : { verdict: 'block', reason: 'Task or permissions changed; retry with the current scope.' };
    },
  };
}

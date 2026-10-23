import type { Session } from '@cindy/maker-core';
import type { FsSessionSnapshot } from '../cindy-brain/fsSlot.js';
import {
  describeFsSessionSnapshotUnavailable,
  resolveGhostFsSessionSnapshot,
  type FsSessionSnapshotUnavailable,
} from './ghostFsSessionSnapshot.js';

/** Accepted-input provenance the Host already records for the running turn. */
export interface TaskActionInputProvenance {
  input: { orcaSenderSessionId?: string } | null;
  executing: boolean;
}

/**
 * Host facts one task-action call is admitted against. Everything here comes from one read
 * of the live Session plus the accepted input; nothing is a persisted preference or an
 * Agent-supplied approval field.
 */
export interface TaskActionInputState {
  key: string;
  /** Reusable live permission decision; `null` means the Agent permission flow cannot take over. */
  permission: FsSessionSnapshot | null;
  /** Why there is none — read with `permission`, never re-derived from a later snapshot. */
  permissionUnavailable: FsSessionSnapshotUnavailable | null;
  ownerInput: boolean;
  automatic: boolean;
  orcaSenderSessionId?: string;
  boundary: string;
}

/**
 * Compose that state. `register.getTaskActionInputState` supplies the process-wide lookups;
 * this function exists so the production composition, not a hand-built scope, is what tests
 * drive (#6756).
 */
export function buildTaskActionInputState(
  sessionId: string,
  deps: {
    session(id: string): Session | undefined;
    provenance(id: string): TaskActionInputProvenance;
    ownerInput(id: string): boolean;
    inputGeneration(id: string): number;
  },
): TaskActionInputState {
  const provenance = deps.provenance(sessionId);
  const session = deps.session(sessionId);
  // Reuse the live permission/Plan generation guard; the DB can lag a mode change.
  const permission = resolveGhostFsSessionSnapshot(deps.session, sessionId, session?.instanceId);
  const ownerInput = deps.ownerInput(sessionId);
  return {
    key: JSON.stringify(provenance),
    permission,
    // The absent decision and the reason for it are one fact: a caller that re-derives
    // "the live states are probably there" from a second read describes a state this Host
    // never emits (a missing snapshot means a state is missing *now*).
    permissionUnavailable: permission ? null : describeFsSessionSnapshotUnavailable(session),
    ownerInput,
    automatic: !!provenance.input && !ownerInput,
    orcaSenderSessionId: provenance.input?.orcaSenderSessionId,
    boundary: `${session?.instanceId ?? ''}:${deps.inputGeneration(sessionId)}`,
  };
}

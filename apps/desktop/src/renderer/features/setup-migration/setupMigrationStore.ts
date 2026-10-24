/**
 * Window-local open state of the new-computer setup dialog. Settings, the first-run
 * suggestion and the checklist all open the same dialog; nothing here is persisted.
 */
import { useSyncExternalStore } from 'react';

export interface SetupMigrationDialogState {
  open: boolean;
  /** Computer to read right away (from the first-run suggestion). */
  deviceId: string | null;
  /** Bumps on every open so the dialog restarts from a clean state. */
  session: number;
}

let state: SetupMigrationDialogState = { open: false, deviceId: null, session: 0 };
const listeners = new Set<() => void>();

function emit(next: SetupMigrationDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function openSetupMigration(deviceId: string | null = null): void {
  emit({ open: true, deviceId, session: state.session + 1 });
}

export function closeSetupMigration(): void {
  if (state.open) emit({ ...state, open: false, deviceId: null });
}

export function subscribeSetupMigration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSetupMigrationState(): SetupMigrationDialogState {
  return state;
}

export function useSetupMigrationDialog(): SetupMigrationDialogState {
  return useSyncExternalStore(subscribeSetupMigration, getSetupMigrationState);
}

/** Settings and the dialog re-read the persisted checklist after either changes it. */
const stateListeners = new Set<() => void>();

export function notifySetupMigrationStateChanged(): void {
  for (const listener of stateListeners) listener();
}

export function subscribeSetupMigrationStateChanged(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { i18n } from '@/i18n';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import {
  dismissNewSessionCreation, getNewSessionCreationTask, prepareNewSessionCreationForEdit,
  stashNewSessionDraftForEdit, type NewSessionCreationTask,
} from './newSessionCreation';

/** Shared by both entry screens; finish recovery even if the initiating screen leaves. */
export async function returnNewSessionToEdit({ sessionId, deviceId, isCurrent, onReady, stashDraft = stashNewSessionDraftForEdit }: {
  sessionId: string;
  deviceId: string;
  isCurrent: () => boolean;
  onReady: (params: { deviceId: string; deviceName: string; recoverySessionId?: string }) => void;
  stashDraft?: (task: NewSessionCreationTask) => void;
}): Promise<void> {
  const owner = getMobileAuthOwner();
  const ownerCurrent = () => isMobileAuthOwnerCurrent(owner);
  if (!ownerCurrent() || !isCurrent() || getNewSessionCreationTask(sessionId)?.deviceId !== deviceId) return;
  const prepared = await prepareNewSessionCreationForEdit(sessionId);
  // Cleanup may already have deleted the worktree. Leaving only cancels navigation,
  // not draft recovery or task dismissal; account changes still fence all writes.
  if (!prepared || !ownerCurrent()) return;
  const durableFirst = getCurrentMobileOutboxRecords().find((record) =>
    record.accountId === owner.accountKey && record.deviceId === deviceId
      && record.item.sessionId === sessionId && record.creation);
  if (durableFirst) {
    await mobileDurableOutbox.update(durableFirst, {
      suspended: true, state: 'failed', error: i18n.t('session.screen.firstMessageNotSent'),
    });
    if (!ownerCurrent()) return;
    dismissNewSessionCreation(sessionId);
    if (isCurrent()) onReady({ deviceId, deviceName: prepared.deviceName, recoverySessionId: sessionId });
    return;
  }
  stashDraft(prepared);
  dismissNewSessionCreation(sessionId, { removeSyntheticRow: true });
  if (isCurrent()) onReady({ deviceId, deviceName: prepared.deviceName });
}

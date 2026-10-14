import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { i18n } from '@/i18n';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import {
  dismissNewSessionCreation, getNewSessionCreationTask, prepareNewSessionCreationForEdit,
  stashNewSessionDraftForEdit, type NewSessionCreationTask,
} from './newSessionCreation';

/** Shared by the source gate and the mounted task screen; cleanup must finish before leaving. */
export async function returnNewSessionToEdit({ sessionId, deviceId, isCurrent, onReady, stashDraft = stashNewSessionDraftForEdit }: {
  sessionId: string;
  deviceId: string;
  isCurrent: () => boolean;
  onReady: (params: { deviceId: string; deviceName: string; recoverySessionId?: string }) => void;
  stashDraft?: (task: NewSessionCreationTask) => void;
}): Promise<void> {
  const owner = getMobileAuthOwner();
  const active = () => isMobileAuthOwnerCurrent(owner) && isCurrent();
  if (!active() || getNewSessionCreationTask(sessionId)?.deviceId !== deviceId) return;
  const prepared = await prepareNewSessionCreationForEdit(sessionId);
  if (!prepared || !active()) return;
  const durableFirst = getCurrentMobileOutboxRecords().find((record) =>
    record.accountId === owner.accountKey && record.deviceId === deviceId
      && record.item.sessionId === sessionId && record.creation);
  if (durableFirst) {
    await mobileDurableOutbox.update(durableFirst, {
      suspended: true, state: 'failed', error: i18n.t('session.screen.firstMessageNotSent'),
    });
    if (!active()) return;
    dismissNewSessionCreation(sessionId);
    onReady({ deviceId, deviceName: prepared.deviceName, recoverySessionId: sessionId });
    return;
  }
  stashDraft(prepared);
  dismissNewSessionCreation(sessionId, { removeSyntheticRow: true });
  onReady({ deviceId, deviceName: prepared.deviceName });
}

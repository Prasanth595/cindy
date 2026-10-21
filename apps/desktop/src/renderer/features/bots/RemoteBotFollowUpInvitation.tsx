import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { BotFollowUpInvitationCard } from './BotFollowUpInvitation';
import { readRemoteBotSettings, settingsClient, type RemoteBotSettingsData } from './remoteBotSettingsData';

/** Uses the existing owner/controller/revision-bound settings action, never a new remote permission. */
export function RemoteBotFollowUpInvitation({ deviceId, botId }: { deviceId: string; botId: string }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<RemoteBotSettingsData | null>(null);
  const [pending, setPending] = useState(false);
  const alive = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    const owner = getDataOwnerGeneration();
    let cancelled = false;
    void readRemoteBotSettings(deviceId, `settings:${botId}/follow-up`, i18n.language)
      .then(next => { if (!cancelled && isDataOwnerGenerationCurrent(owner)) setData(next); })
      .catch(() => {}); // Older hosts do not offer this optional invitation.
    return () => { cancelled = true; alive.current = false; };
  }, [botId, deviceId, i18n.language]);
  const panel = data?.panels.find(item => item.id === 'follow-up');
  if (!data || !panel?.invitationAvailable || !panel.action || !panel.dismissAction) return null;
  const choose = async (enable: boolean) => {
    const actionId = (enable ? panel.action : panel.dismissAction)?.id;
    if (saving.current || !actionId) return;
    saving.current = true; setPending(true);
    const owner = getDataOwnerGeneration();
    try {
      await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
        client: settingsClient(i18n.language), collectionId: 'teammates', resourceRef: data.resource.ref,
        actionId, input: enable ? { enabled: true } : {},
      }]);
      if (alive.current && isDataOwnerGenerationCurrent(owner)) setData(null);
    } catch {
      if (alive.current && isDataOwnerGenerationCurrent(owner)) {
        toast.error(t('bots.autonomy.saveFailed'));
        const next = await readRemoteBotSettings(deviceId, `settings:${botId}/follow-up`, i18n.language).catch(() => null);
        if (alive.current && isDataOwnerGenerationCurrent(owner)) setData(next);
      }
    } finally { saving.current = false; if (alive.current) setPending(false); }
  };
  return <BotFollowUpInvitationCard pending={pending} onChoose={choose} consent={panel.text} />;
}

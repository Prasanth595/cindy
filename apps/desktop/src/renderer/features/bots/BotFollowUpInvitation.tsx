import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { setBotSchedulerBotId, useBotAutonomySettings } from './botStore';

/** A local invitation after a user sends a message; showing it never runs a model or reads tasks. */
export function BotFollowUpInvitation({ botId, engaged }: { botId: string; engaged: boolean }) {
  const { t } = useTranslation();
  const settings = useBotAutonomySettings();
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  if (!engaged || !settings || settings.isCustomized || settings.schedulerBotId !== null) return null;

  const choose = async (enable: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    const owner = getDataOwnerGeneration();
    try {
      // null is an explicit choice too: do not ask again after "Not now".
      await setBotSchedulerBotId(enable ? botId : null);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('bots.autonomy.saveFailed'));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <BotFollowUpInvitationCard pending={pending} onChoose={choose} />;
}

export function BotFollowUpInvitationCard({ pending, onChoose, consent }: {
  pending: boolean; onChoose(enable: boolean): void | Promise<void>; consent?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="w-full rounded-xl border border-[var(--border-default)] p-4" aria-label={t('bots.autonomy.invitation.title')}>
      <p className="text-13 font-medium leading-5 text-[var(--text-primary)]">{t('bots.autonomy.invitation.title')}</p>
      <p className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">{consent ?? t('bots.autonomy.consent')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="cta" size="md" disabled={pending} onClick={() => void onChoose(true)}>{t('bots.autonomy.invitation.start')}</Button>
        <Button variant="secondary" tone="quiet" size="md" disabled={pending} onClick={() => void onChoose(false)}>{t('bots.autonomy.invitation.notNow')}</Button>
      </div>
    </section>
  );
}

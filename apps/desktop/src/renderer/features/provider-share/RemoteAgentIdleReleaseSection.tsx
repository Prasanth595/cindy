import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import {
  isRemoteAgentIdleRelease,
  REMOTE_AGENT_IDLE_RELEASE_MAX_MINUTES,
  type RemoteAgentIdleReleaseView,
} from '../../../shared/remoteAgentIdleRelease';

/**
 * 这台电脑作为使用方：用其他电脑上的模型时，快到那台电脑的任务数上限时，闲置多久的任务先暂时断开
 * (main 的 remote-agent/controller/connectionPool.ts)。设置只在这台电脑上，不随管理的电脑切换。
 */
export function RemoteAgentIdleReleaseSection() {
  const { t } = useTranslation();
  const [view, setView] = useState<RemoteAgentIdleReleaseView | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    const owner = getDataOwnerGeneration();
    try {
      const next = await window.electronAPI.providerShare.command({ action: 'get-idle-release' });
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setView(next);
      setErrorKey(null);
    } catch (error) {
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setErrorKey(mapIpcErrorToI18nKey(error));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { sequence.current += 1; };
  }, [load]);

  const value = draft ?? String(view?.value.idleMinutes ?? '');
  const minutes = Number(value);
  const valid = value.trim() !== '' && isRemoteAgentIdleRelease({ idleMinutes: minutes });
  const changed = view !== null && draft !== null && (minutes !== view.value.idleMinutes || !view.isCustomized);

  const save = async (reset: boolean) => {
    if (busy || (!reset && !valid)) return;
    setBusy(true);
    const seq = ++sequence.current;
    const owner = getDataOwnerGeneration();
    try {
      const next = await window.electronAPI.providerShare.command(reset
        ? { action: 'reset-idle-release' }
        : { action: 'set-idle-release', value: { idleMinutes: minutes } });
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      setView(next);
      setDraft(null);
      setErrorKey(null);
      toast.success(t('providerShare.idleRelease.saved'));
    } catch (error) {
      if (seq !== sequence.current || !isDataOwnerGenerationCurrent(owner)) return;
      toast.error(t(mapIpcErrorToI18nKey(error)));
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  };

  return (
    <section className="mt-8 shrink-0" data-testid="remote-agent-idle-release" aria-labelledby="remote-agent-idle-release-title">
      <h3 id="remote-agent-idle-release-title" className="text-13 font-medium text-[var(--settings-section-title)]">
        {t('providerShare.idleRelease.title')}
      </h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--settings-section-desc)]">{t('providerShare.idleRelease.description')}</p>
      {errorKey && <p role="alert" className="mt-3 text-12 leading-[1.5] text-[var(--text-danger)]">{t(errorKey)}</p>}
      {!view ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
          {t(errorKey ? 'providerShare.idleRelease.retry' : 'providerShare.idleRelease.loading')}
        </Button>
      ) : (
        <form className="mt-4 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(false); }}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label={t('providerShare.idleRelease.minutes')} hint={t('providerShare.idleRelease.hint')}>
              {control => <Input {...control} type="number" min={0} max={REMOTE_AGENT_IDLE_RELEASE_MAX_MINUTES} step={1}
                disabled={busy} value={value} data-testid="remote-agent-idle-release-minutes"
                onChange={next => setDraft(next)} />}
            </FormField>
          </div>
          {draft !== null && !valid && (
            <p role="alert" className="text-12 leading-[1.5] text-[var(--text-danger)]">
              {t('providerShare.idleRelease.invalid', { max: REMOTE_AGENT_IDLE_RELEASE_MAX_MINUTES })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="cta" size="sm" disabled={busy || !valid || !changed}>{t('providerShare.idleRelease.save')}</Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy || !view.isCustomized} onClick={() => void save(true)}>
              {t('providerShare.idleRelease.reset')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

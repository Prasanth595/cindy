import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { crossAgentConvertService } from '@/lib/crossAgentConvertService';
import { toast } from '@/lib/toast';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

/** Low-frequency recovery, visible only after explicitly hiding a prompt. */
export function MigrationPromptSection() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    // Old hosts don't offer these local-only preferences.
    if (!window.electronAPI?.maker?.crossAgent?.listSuppressedWorkspaces) return;
    void crossAgentConvertService
      .listSuppressedWorkspaces()
      .then((value) => {
        if (active) setWorkspaces(value);
      })
      .catch(() => {
        if (active) toast.error(t('commonUi.crossAgentConvert.preferenceLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [t]);

  const restore = async (workingDir: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      setWorkspaces(await crossAgentConvertService.restoreAgentsMdPrompt(workingDir));
    } catch {
      toast.error(t('commonUi.crossAgentConvert.preferenceFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (workspaces.length === 0) return null;
  return (
    <section className="py-[18px]" aria-label={t('commonUi.crossAgentConvert.preferencesTitle')}>
      <div className="flex flex-col gap-[14px]">
        <h2 className={SETTINGS_SECTION_TITLE_CLASS}>
          {t('commonUi.crossAgentConvert.preferencesTitle')}
        </h2>
        <p className={SETTINGS_ROW_HINT_CLASS}>{t('commonUi.crossAgentConvert.preferencesHint')}</p>
        <div className={SETTINGS_CARD_CLASS}>
          {workspaces.map((workingDir, index) => (
            <div key={workingDir}>
              {index > 0 && <div className={SETTINGS_ROW_DIVIDER_CLASS} />}
              <div className={SETTINGS_ROW_CLASS}>
                <span className="min-w-0 break-all text-13 text-[var(--text-primary)]">
                  {workingDir}
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  className="shrink-0"
                  disabled={busy}
                  aria-label={t('commonUi.crossAgentConvert.restoreWorkspace', { workingDir })}
                  onClick={() => void restore(workingDir)}
                >
                  {t('commonUi.crossAgentConvert.restorePrompt')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

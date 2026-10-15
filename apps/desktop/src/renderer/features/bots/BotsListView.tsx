import { useTranslation } from 'react-i18next';

/**
 * BotsFeatureLayout already supplies the partner list in its sidebar. Leave the
 * content pane unselected on startup: /bots selects Cindy and /bots/roster opens
 * the creation dialog. Neither belongs to passive navigation restoration.
 */
export function BotsListView() {
  const { t } = useTranslation();

  return (
    <main className="flex h-full items-center justify-center p-6">
      <p className="text-center text-14 leading-[1.43] text-[var(--text-tertiary)]">
        {t('bots.list.selectChat')}
      </p>
    </main>
  );
}

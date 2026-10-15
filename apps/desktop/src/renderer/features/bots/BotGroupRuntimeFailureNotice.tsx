import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { isBotGroupRuntimeFailureCode } from '../../../shared/botGroupChat';

/**
 * A failed member turn inside the group timeline. The cause and remedy stay group-safe;
 * `onRetry` is only given when the host can re-issue this member's request (a member
 * turn, not a plan step, whose source message is still loaded and resendable).
 */
export function BotGroupRuntimeFailureNotice({ name, code, onRetry, retrying }: {
  name: string;
  code: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation();
  if (!isBotGroupRuntimeFailureCode(code)) return null;
  return (
    <div className="mx-auto flex max-w-[560px] flex-col items-center gap-2">
      <p className="whitespace-pre-line text-center text-13 leading-5 text-[var(--text-primary)]">
        {t(`bots.groupChat.notice.runtimeFailure.${code}`, { name })}
      </p>
      {onRetry ? (
        <Button variant="secondary" size="sm" compact type="button" loading={retrying} onClick={onRetry}>
          {t('commonUi.retry')}
        </Button>
      ) : null}
    </div>
  );
}

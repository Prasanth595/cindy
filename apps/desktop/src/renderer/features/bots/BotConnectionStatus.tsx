import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Cached/unknown connectivity must never be presented as offline. */
export function isBotKnownOffline(online?: boolean | null, connectionKnown?: boolean): boolean {
  return online === false && connectionKnown !== false;
}

export function BotConnectionStatus({
  online = true,
  connectionKnown,
  deviceName,
  inline = false,
  homeOffline = false,
  className,
}: {
  online?: boolean | null;
  connectionKnown?: boolean;
  /** The device is this companion's main computer (cloud companions): say so when offline. */
  homeOffline?: boolean;
  deviceName?: string;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const offline = isBotKnownOffline(online, connectionKnown);
  const status = offline ? t(homeOffline ? 'bots.cloud.homeOfflineShort' : 'bots.remote.offline') : '';
  const name = deviceName?.trim();
  const label = [status, name].filter(Boolean).join(' · ');
  if (inline) {
    if (!label) return null;
    return (
      <span title={label} className={cn('min-w-0 truncate text-11 leading-normal', className)}>
        {label}
      </span>
    );
  }
  if (!offline) return null;
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
        'bg-[var(--remote-status-failed)]',
      )}
    />
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ComposerActivityPill, makeComposerActivityPillStyles } from '@/session/ComposerActivityPill';
import { useThemedStyles } from '@/theme';

export type SlowSendPhase = 'preparing' | 'uploading' | 'connecting' | 'checkingModel' | 'creating' | 'sending';
export const SLOW_SEND_NOTICE_DELAY_MS = 8_000;

/** True once a send has waited past the delay; one elapsed clock survives phase changes and page handoff. */
export function useSlowSendVisible(startedAt: number | null): boolean {
  const [visibleFor, setVisibleFor] = useState<number | null>(null);
  useEffect(() => {
    setVisibleFor(null);
    if (startedAt === null) return;
    const timer = setTimeout(() => setVisibleFor(startedAt), Math.max(0, startedAt + SLOW_SEND_NOTICE_DELAY_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [startedAt]);
  return startedAt !== null && visibleFor === startedAt;
}

/**
 * New-task page only: before handoff there is no activity row yet, so a slow send shows the same
 * pill the task page uses for "思考中", and the task page continues it in place. Fast sends add nothing.
 */
export function SlowSendNotice({ startedAt, phase }: { startedAt: number | null; phase: SlowSendPhase }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeComposerActivityPillStyles);
  if (!useSlowSendVisible(startedAt)) return null;
  return (
    <View pointerEvents="none" style={styles.composerActivityStatus} testID="session.slowSendNotice">
      <ComposerActivityPill label={t(`session.new.slowSend.${phase}`)} live />
    </View>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import { retryNewSessionCreation, type NewSessionCreationTask } from './newSessionCreation';
import { returnNewSessionToEdit } from './returnNewSessionToEdit';

/** Local entry chrome stays available even when remote task content cannot mount. */
export function SessionEntryStatus({ title, copy, loading, children }: {
  title: string; copy: string; loading?: boolean; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <MainWindowEmptyState title={title} copy={copy} centered style={styles.card} testID="session.entryStatus">
          {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <View style={styles.actions}>
            {children}
            <MainWindowActionButton action={{
              label: t('session.entry.back'), testID: 'session.entryBack',
              onPress: () => goBackGuarded(router),
            }} numberOfLines={0} />
          </View>
        </MainWindowEmptyState>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Render creation progress/recovery without granting access to unknown remote content. */
export function LocalSessionCreationRecovery({ task }: { task: NewSessionCreationTask }) {
  const { t } = useTranslation();
  const router = useRouter();
  const alive = useRef(true);
  const editing = useRef(false);
  const [pending, setPending] = useState(false);
  const busy = pending || task.returningToEdit === true;
  const [editError, setEditError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const failed = task.status === 'create-failed';
  const backToEdit = async () => {
    if (editing.current || busy) return;
    editing.current = true;
    setPending(true);
    setEditError(null);
    try {
      await returnNewSessionToEdit({
        sessionId: task.sessionId, deviceId: task.deviceId, isCurrent: () => alive.current,
        onReady: params => router.replace({ pathname: '/sessions/new', params }),
      });
    } catch (error) {
      if (alive.current) setEditError(formatRemoteError(error));
    } finally {
      editing.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <SessionEntryStatus
      title={t(failed ? 'session.screen.createFailedTitle' : 'session.new.slowSend.creating')}
      copy={editError ?? (failed
        ? task.error ?? t('session.screen.createFailedDefault')
        : t(`session.new.slowSend.${task.phase}`))}
      loading={!failed || busy}
    >
      {failed ? <>
        <MainWindowActionButton action={{
          label: t('session.screen.retry'), testID: 'session.creationRetry', disabled: busy || !!task.readyForEdit || !!task.worktreeCleanupAcknowledged,
          onPress: () => { if (!editing.current && !busy && !task.readyForEdit && !task.worktreeCleanupAcknowledged) retryNewSessionCreation(task.sessionId); },
        }} numberOfLines={0} />
        <MainWindowActionButton action={{
          label: t('session.screen.backToEdit'), testID: 'session.creationEdit', busy,
          onPress: () => { void backToEdit(); },
        }} numberOfLines={0} />
      </> : null}
    </SessionEntryStatus>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.surfaceElevated, padding: spacing.xl },
  actions: { gap: spacing.sm, marginTop: spacing.md },
});

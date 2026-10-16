import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react-native';
import {
  SPEAKER_ENROLLMENT_CLIP_COUNT,
  SPEAKER_GATE_STRICTNESS_VALUES,
  type SpeakerGateStrictness,
} from '@cindy/voice-input-core';

import { Text } from '@/components/AppText';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import {
  ActionInfoRow,
  InfoRow,
  SettingsGroup,
  SettingsSwitchRow,
  useSettingsRowStyles,
} from '@/session/SettingsGroupRows';
import {
  cancelMobileSpeakerModelDownload,
  deleteMobileSpeakerProfile,
  downloadMobileSpeakerModels,
  enrollMobileSpeaker,
  getMobileSpeakerFilterSnapshot,
  hydrateMobileSpeakerFilter,
  setMobileSpeakerFilterEnabled,
  setMobileSpeakerFilterStrictness,
  subscribeMobileSpeakerFilter,
  type MobileSpeakerFilterSnapshot,
} from '@/session/mobileSpeakerFilter';
import {
  MobileSpeakerEnrollmentAbortedError,
  MobileSpeakerEnrollmentNoAudioError,
  recordMobileSpeakerClip,
} from '@/session/mobileSpeakerEnrollmentRecorder';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

const CLIP_SECONDS = 6;
const CLIP_INDEXES = Array.from({ length: SPEAKER_ENROLLMENT_CLIP_COUNT }, (_, index) => index);

type EnrollErrorKey =
  | 'too_short'
  | 'no_embedding'
  | 'inconsistent'
  | 'models_missing'
  | 'storage_unavailable'
  | 'failed'
  | 'microphone'
  | 'noAudio';

/**
 * 「识别我的声音」(设置的二级页)。
 *
 * 开关第一次打开时下载识别模型;模型就绪后朗读三段文字录入声纹;录好后可调灵敏度。
 * 声纹只存在这台手机(系统钥匙串 / Keystore),按账号分开,不同步、不上传。
 * 任一条件不满足时语音输入照常工作,只是不过滤。
 *
 * SettingsGroup 按直接子元素画分隔线,所以每组的行都以带 key 的数组给出,不包 Fragment。
 */
export default function VoiceSpeakerFilterScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  // The model covers Chinese and English; other UI locales use English passages.
  const passageLanguage = language === 'zh-CN' || language === 'zh-TW' ? language : 'en';
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const state = useSyncExternalStore(subscribeMobileSpeakerFilter, getMobileSpeakerFilterSnapshot);

  const [enrolling, setEnrolling] = useState(false);
  const [clips, setClips] = useState<Array<ArrayBuffer | null>>(() => CLIP_INDEXES.map(() => null));
  const [current, setCurrent] = useState(0);
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [enrollError, setEnrollError] = useState<{ key: EnrollErrorKey; clipIndex?: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const reportActionFailure = useCallback(() => {
    Alert.alert(t('settings.voiceSpeakerFilter.actionFailed'));
  }, [t]);

  useEffect(() => {
    void hydrateMobileSpeakerFilter();
  }, []);

  // Never leave the microphone open behind a closed screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  const resetEnrollment = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setClips(CLIP_INDEXES.map(() => null));
    setCurrent(0);
    setRecording(false);
    setProgress(0);
    setSaving(false);
    setEnrollError(null);
  }, []);

  const record = useCallback(async () => {
    if (abortRef.current || recording || saving) return;
    setEnrollError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const index = current;
    setRecording(true);
    setProgress(0);
    try {
      const clip = await recordMobileSpeakerClip({
        durationMs: CLIP_SECONDS * 1000,
        onProgress: (fraction) => {
          if (abortRef.current === controller && !controller.signal.aborted) setProgress(fraction);
        },
        signal: controller.signal,
      });
      if (abortRef.current !== controller || controller.signal.aborted) return;
      const next = [...clipsRef.current];
      next[index] = clip;
      setClips(next);
      const nextEmpty = CLIP_INDEXES.find((candidate) => !next[candidate]);
      if (nextEmpty !== undefined) setCurrent(nextEmpty);
    } catch (error) {
      if (abortRef.current !== controller || error instanceof MobileSpeakerEnrollmentAbortedError) return;
      // A denied permission and a failing device both mean "check the microphone".
      setEnrollError({ key: error instanceof MobileSpeakerEnrollmentNoAudioError ? 'noAudio' : 'microphone' });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRecording(false);
      }
    }
  }, [current, recording, saving]);

  const submit = useCallback(async () => {
    if (!clips.every((clip) => clip !== null) || saving || recording) return;
    setSaving(true);
    setEnrollError(null);
    const result = await enrollMobileSpeaker(clips as ArrayBuffer[]);
    setSaving(false);
    if (result.ok) {
      resetEnrollment();
      setEnrolling(false);
      return;
    }
    setEnrollError({ key: result.reason, clipIndex: result.clipIndex });
    if (result.clipIndex !== undefined) {
      const redo = result.clipIndex;
      setClips((previous) => previous.map((clip, index) => (index === redo ? null : clip)));
      setCurrent(redo);
    }
  }, [clips, recording, resetEnrollment, saving]);

  const confirmDelete = useCallback(() => {
    Alert.alert(
      t('settings.voiceSpeakerFilter.profile.deleteConfirm.title'),
      t('settings.voiceSpeakerFilter.profile.deleteConfirm.description'),
      [
        { text: t('settings.voiceSpeakerFilter.profile.deleteConfirm.cancel'), style: 'cancel' },
        {
          text: t('settings.voiceSpeakerFilter.profile.deleteConfirm.confirm'),
          style: 'destructive',
          onPress: () => {
            void deleteMobileSpeakerProfile().catch(reportActionFailure);
          },
        },
      ],
    );
  }, [reportActionFailure, t]);

  const showDetails = state.supported && state.hydrated && (state.enabled || state.enrolled);
  const modelsReady = state.modelState === 'ready';
  const allRecorded = clips.every((clip) => clip !== null);
  const recordLabel = t(clips[current]
    ? 'settings.voiceSpeakerFilter.enroll.rerecord'
    : 'settings.voiceSpeakerFilter.enroll.record');

  const deleteRow = (
    <ActionInfoRow
      key="delete"
      accessibilityLabel={t('settings.voiceSpeakerFilter.profile.delete')}
      label={t('settings.voiceSpeakerFilter.profile.delete')}
      onPress={confirmDelete}
      testID="settings.voiceSpeakerFilter.profile.delete"
    />
  );

  const enrollmentRows: ReactNode[] = [
    <View key="description" style={rowStyles.row}>
      <Text style={rowStyles.rowDetail}>
        {t('settings.voiceSpeakerFilter.enroll.description', {
          clips: SPEAKER_ENROLLMENT_CLIP_COUNT,
          seconds: CLIP_SECONDS,
        })}
      </Text>
    </View>,
    ...CLIP_INDEXES.map((index) => {
      const stepLabel = t('settings.voiceSpeakerFilter.enroll.step', {
        current: index + 1,
        total: SPEAKER_ENROLLMENT_CLIP_COUNT,
      });
      return (
        <Pressable
          key={`step-${index}`}
          accessibilityLabel={stepLabel}
          accessibilityRole="button"
          accessibilityState={{ selected: index === current, disabled: recording || saving }}
          disabled={recording || saving}
          onPress={() => {
            setCurrent(index);
            setEnrollError(null);
          }}
          style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
          testID={`settings.voiceSpeakerFilter.enroll.step.${index}`}
        >
          <View style={rowStyles.rowLine}>
            <Text style={rowStyles.rowLabel}>{stepLabel}</Text>
            {clips[index] ? (
              <Check color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            ) : null}
          </View>
          {index === current ? (
            <Text style={rowStyles.rowLabel}>
              {t(`settings.voiceSpeakerFilter.enroll.passages.p${index + 1}`, { lng: passageLanguage })}
            </Text>
          ) : null}
        </Pressable>
      );
    }),
    <ActionInfoRow
      key="record"
      accessibilityLabel={recordLabel}
      disabled={recording || saving}
      label={recordLabel}
      onPress={() => {
        void record();
      }}
      testID="settings.voiceSpeakerFilter.enroll.record"
      value={recording
        ? t('settings.voiceSpeakerFilter.enroll.recording', {
          seconds: Math.max(0, Math.ceil(CLIP_SECONDS * (1 - progress))),
        })
        : ''}
    />,
    enrollError ? (
      <View key="error" style={rowStyles.row}>
        <Text accessibilityRole="alert" style={rowStyles.rowDetail}>
          {t(`settings.voiceSpeakerFilter.enroll.errors.${enrollError.key}`, {
            index: (enrollError.clipIndex ?? 0) + 1,
          })}
        </Text>
      </View>
    ) : null,
    <ActionInfoRow
      key="submit"
      accessibilityLabel={t('settings.voiceSpeakerFilter.enroll.submit')}
      disabled={!allRecorded || recording || saving}
      label={t('settings.voiceSpeakerFilter.enroll.submit')}
      onPress={() => {
        void submit();
      }}
      testID="settings.voiceSpeakerFilter.enroll.submit"
      value={saving ? t('settings.voiceSpeakerFilter.enroll.saving') : ''}
    />,
    <ActionInfoRow
      key="cancel"
      accessibilityLabel={t('settings.voiceSpeakerFilter.enroll.cancel')}
      disabled={saving}
      label={t('settings.voiceSpeakerFilter.enroll.cancel')}
      onPress={() => {
        resetEnrollment();
        setEnrolling(false);
      }}
      testID="settings.voiceSpeakerFilter.enroll.cancel"
    />,
  ];

  const profileRows: ReactNode[] = [
    <InfoRow
      key="status"
      detail={state.enrolled && state.enrolledAt
        ? t('settings.voiceSpeakerFilter.profile.enrolledAt', {
          date: new Date(state.enrolledAt).toLocaleDateString(),
        })
        : t('settings.voiceSpeakerFilter.profile.missingHint')}
      label={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.enrolled'
        : 'settings.voiceSpeakerFilter.profile.missing')}
      testID="settings.voiceSpeakerFilter.profile.status"
      value=""
    />,
    <ActionInfoRow
      key="enroll"
      accessibilityLabel={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.reenroll'
        : 'settings.voiceSpeakerFilter.profile.enroll')}
      label={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.reenroll'
        : 'settings.voiceSpeakerFilter.profile.enroll')}
      onPress={() => {
        resetEnrollment();
        setEnrolling(true);
      }}
      testID="settings.voiceSpeakerFilter.profile.enroll"
    />,
    state.enrolled ? deleteRow : null,
  ];

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.voiceSpeakerFilter.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.voiceSpeakerFilter.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.voiceSpeakerFilter.title')}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content} testID="settings.voiceSpeakerFilter.scroll">
        <SettingsGroup footer={t('settings.voiceSpeakerFilter.privacy')}>
          <SettingsSwitchRow
            accessibilityLabel={t('settings.voiceSpeakerFilter.label')}
            disabled={!state.supported || !state.hydrated || saving}
            hint={state.supported ? t('settings.voiceSpeakerFilter.hint') : t('settings.voiceSpeakerFilter.unsupported')}
            label={t('settings.voiceSpeakerFilter.label')}
            onValueChange={(value) => {
              if (!value) {
                resetEnrollment();
                setEnrolling(false);
              }
              void setMobileSpeakerFilterEnabled(value).catch(reportActionFailure);
            }}
            switchTestID="settings.voiceSpeakerFilter.toggle"
            testID="settings.voiceSpeakerFilter.toggleRow"
            value={state.enabled && state.supported}
          />
        </SettingsGroup>

        {showDetails && !modelsReady ? <ModelGroup state={state} /> : null}

        {showDetails && modelsReady ? (
          <SettingsGroup title={t('settings.voiceSpeakerFilter.profile.title')}>
            {enrolling ? enrollmentRows : profileRows}
          </SettingsGroup>
        ) : null}

        {showDetails && !modelsReady && state.enrolled ? (
          <SettingsGroup title={t('settings.voiceSpeakerFilter.profile.title')}>
            {deleteRow}
          </SettingsGroup>
        ) : null}

        {showDetails && state.enrolled && !enrolling ? (
          <SettingsGroup
            footer={t('settings.voiceSpeakerFilter.strictness.hint')}
            title={t('settings.voiceSpeakerFilter.strictness.label')}
          >
            {[
              ...SPEAKER_GATE_STRICTNESS_VALUES.map((value) => (
                <StrictnessRow
                  key={value}
                  onPress={() => {
                    void setMobileSpeakerFilterStrictness(value).catch(reportActionFailure);
                  }}
                  selected={state.strictness === value}
                  value={value}
                />
              )),
              state.strictnessCustomized ? (
                <ActionInfoRow
                  key="restore"
                  accessibilityLabel={t('settings.voiceSpeakerFilter.strictness.restoreDefault')}
                  label={t('settings.voiceSpeakerFilter.strictness.restoreDefault')}
                  onPress={() => {
                    void setMobileSpeakerFilterStrictness(null).catch(reportActionFailure);
                  }}
                  testID="settings.voiceSpeakerFilter.strictness.restore"
                />
              ) : null,
            ]}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ModelGroup({ state }: { state: MobileSpeakerFilterSnapshot }) {
  const { t } = useTranslation();
  const rowStyles = useSettingsRowStyles();
  const total = formatMegabytes(state.totalBytes);
  if (state.modelState === 'downloading') {
    return (
      <SettingsGroup title={t('settings.voiceSpeakerFilter.model.title')}>
        <ActionInfoRow
          accessibilityLabel={t('settings.voiceSpeakerFilter.model.cancel')}
          detail={t('settings.voiceSpeakerFilter.model.downloading', {
            done: formatMegabytes(state.downloadedBytes),
            total,
          })}
          label={t('settings.voiceSpeakerFilter.model.cancel')}
          onPress={cancelMobileSpeakerModelDownload}
          testID="settings.voiceSpeakerFilter.model.cancel"
        />
      </SettingsGroup>
    );
  }
  const failed = state.modelState === 'failed';
  return (
    <SettingsGroup title={t('settings.voiceSpeakerFilter.model.title')}>
      {[
        failed ? (
          <View key="error" style={rowStyles.row}>
            <Text accessibilityRole="alert" style={rowStyles.rowDetail}>
              {t(`settings.voiceSpeakerFilter.model.failed.${state.downloadError ?? 'network'}`)}
            </Text>
          </View>
        ) : null,
        <ActionInfoRow
          key="download"
          accessibilityLabel={t(failed ? 'settings.voiceSpeakerFilter.model.retry' : 'settings.voiceSpeakerFilter.model.download')}
          detail={failed ? undefined : t('settings.voiceSpeakerFilter.model.needed', { size: total })}
          label={t(failed ? 'settings.voiceSpeakerFilter.model.retry' : 'settings.voiceSpeakerFilter.model.download')}
          onPress={() => {
            void downloadMobileSpeakerModels();
          }}
          testID="settings.voiceSpeakerFilter.model.download"
        />,
      ]}
    </SettingsGroup>
  );
}

function StrictnessRow({
  onPress,
  selected,
  value,
}: {
  onPress(): void;
  selected: boolean;
  value: SpeakerGateStrictness;
}) {
  const { t } = useTranslation();
  const rowStyles = useSettingsRowStyles();
  const { colors } = useTheme();
  const label = t(`settings.voiceSpeakerFilter.strictness.options.${value}`);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
      testID={`settings.voiceSpeakerFilter.strictness.${value}`}
    >
      <View style={rowStyles.rowLine}>
        <Text style={rowStyles.rowLabel}>{label}</Text>
        {selected ? <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} /> : null}
      </View>
    </Pressable>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
});

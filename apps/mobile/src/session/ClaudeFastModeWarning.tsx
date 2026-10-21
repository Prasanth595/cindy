import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { NativeSwitch } from "@/platform/chrome";
import {
  fontWeight,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import type { ClaudeFastModeConfirmation } from "./useClaudeFastModeConfirmation";

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: { gap: spacing.lg, padding: spacing.lg },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
    },
    description: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: 44,
    },
    label: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
  });

export function ClaudeFastModeWarning(p: ClaudeFastModeConfirmation) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.content} testID="claudeFastWarning">
      <Text style={styles.title}>{t("models.claudeFastWarning.title")}</Text>
      <Text style={styles.description}>
        {t("models.claudeFastWarning.description")}
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>
          {t("models.claudeFastWarning.dontShowAgain")}
        </Text>
        <NativeSwitch
          value={p.dontShowAgain}
          onValueChange={p.onDontShowAgain}
          disabled={p.saving}
          accessibilityLabel={t("models.claudeFastWarning.dontShowAgain")}
          seedColor={colors.inputCaret}
          testID="claudeFastWarning.dontShowAgain"
        />
      </View>
      <MainWindowActionButton
        numberOfLines={0}
        action={{
          label: t("models.claudeFastWarning.confirm"),
          onPress: p.onConfirm,
          disabled: p.saving,
          tone: "primary",
          testID: "claudeFastWarning.confirm",
        }}
      />
      <MainWindowActionButton
        numberOfLines={0}
        action={{
          label: t("devices.common.cancel"),
          onPress: p.onCancel,
          disabled: p.saving,
          testID: "claudeFastWarning.cancel",
        }}
      />
    </View>
  );
}

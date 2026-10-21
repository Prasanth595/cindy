import { Text, Toggle } from "@expo/ui/swift-ui";
import {
  disabled,
  font,
  foregroundStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/theme";
import { ComposerNativeSection as Section } from "./ComposerNativeSection";
import { ComposerNativeRow } from "./ComposerNativeRow";
import type { ClaudeFastModeConfirmation } from "./useClaudeFastModeConfirmation";

export function ClaudeFastModeWarning(p: ClaudeFastModeConfirmation) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <>
      <Section title={t("models.claudeFastWarning.title")}>
        <Text
          modifiers={[
            font({ textStyle: "footnote" }),
            foregroundStyle(colors.textSecondary),
          ]}
        >
          {t("models.claudeFastWarning.description")}
        </Text>
      </Section>
      <Section>
        <Toggle
          label={t("models.claudeFastWarning.dontShowAgain")}
          isOn={p.dontShowAgain}
          onIsOnChange={p.onDontShowAgain}
          modifiers={[disabled(p.saving), tint(colors.inputCaret)]}
          testID="claudeFastWarning.dontShowAgain"
        />
      </Section>
      <Section>
        <ComposerNativeRow
          title={t("models.claudeFastWarning.confirm")}
          onPress={p.onConfirm}
          disabled={p.saving}
          testID="claudeFastWarning.confirm"
        />
        <ComposerNativeRow
          title={t("devices.common.cancel")}
          onPress={p.onCancel}
          disabled={p.saving}
          testID="claudeFastWarning.cancel"
        />
      </Section>
    </>
  );
}

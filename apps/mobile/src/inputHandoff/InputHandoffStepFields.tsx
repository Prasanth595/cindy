import { Pressable, ScrollView, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  InputHandoffAction,
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  type MainWindowAction,
} from "@/components/MobilePrimitives";
import { useTheme, useThemedStyles } from "@/theme";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import { nativeTextInputProps } from "./inputHandoffNative";

type ButtonControl = Extract<InputHandoffControl, { kind: "button" }>;

/** One screen as native fields, in screen order. */
export function InputHandoffStepFields({
  snapshot,
  draft,
  disabled,
  busy,
  onChange,
  onSubmit,
  onDecide,
}: {
  snapshot: InputHandoffSnapshot;
  draft: InputHandoffValues;
  disabled: boolean;
  busy: boolean;
  onChange(id: string, value: string | boolean): void;
  onSubmit(action: InputHandoffAction): void;
  onDecide(action: "done" | "cancel" | "refresh" | "decline" | "picture"): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const buttons = snapshot.controls.filter(
    (c): c is ButtonControl => c.kind === "button",
  );
  const fields = snapshot.controls.filter(
    (c) => c.kind === "text" || c.kind === "choice" || c.kind === "toggle",
  );
  const primary = buttons.find((b) => b.primary);
  const confirm = () =>
    onSubmit(
      primary ? { kind: "press", controlId: primary.id } : { kind: "submit" },
    );

  // A terminal prompt (sudo / ssh / git) is one answer to one program: no
  // screen to re-read, fill without confirming, or hand back.
  const terminal = Boolean(snapshot.command);
  const footer: MainWindowAction[] = terminal
    ? []
    : [{ label: t("interaction.inputHandoff.action.done"), disabled: busy, tone: "secondary", onPress: () => onDecide("done") }];
  if (buttons.length === 0 && fields.length > 0) {
    if (!terminal)
      footer.push({ label: t("interaction.inputHandoff.action.fill"), disabled, tone: "secondary", onPress: () => onSubmit({ kind: "fill" }) });
    footer.push({ label: t("interaction.inputHandoff.action.submit"), disabled, tone: "primary", onPress: () => onSubmit({ kind: "submit" }) });
  }

  return (
    <View style={styles.stack}>
      {snapshot.remoteInput !== true ? (
        <Text style={styles.note}>{t("interaction.inputHandoff.remoteUnavailable")}</Text>
      ) : null}
      {snapshot.controls.map((control) => {
        if (control.kind === "note")
          return (
            <Text key={control.id} style={control.tone === "heading" ? styles.heading : styles.note}>
              {control.text}
            </Text>
          );
        if (control.kind === "text") {
          const value = typeof draft[control.id] === "string" ? (draft[control.id] as string) : "";
          const label = control.label || t(unnamedFieldKey(control.contentType));
          return (
            <View key={control.id} style={styles.field}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                accessibilityLabel={label}
                value={value}
                onChangeText={(v) => onChange(control.id, v)}
                placeholder={control.placeholder}
                placeholderTextColor={colors.textPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={!disabled}
                multiline={control.multiline === true}
                returnKeyType={control.multiline ? "default" : "done"}
                onSubmitEditing={control.multiline ? undefined : confirm}
                style={styles.input}
                {...nativeTextInputProps(control.contentType)}
              />
              {control.filled ? (
                <Text style={styles.note}>{t("interaction.inputHandoff.filledHint")}</Text>
              ) : null}
              {control.suggestions?.length ? (
                <View style={styles.wrap}>
                  {control.suggestions.slice(0, 12).map((o) => (
                    <MainWindowActionButton
                      key={o.id}
                      density="compact"
                      action={{ label: o.label, disabled, tone: "secondary", onPress: () => onChange(control.id, o.label) }}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          );
        }
        if (control.kind === "choice") {
          const label = control.label || t("interaction.inputHandoff.unnamedChoice");
          return (
            <View key={control.id} style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
              <Text style={styles.label}>{label}</Text>
              <ScrollView nestedScrollEnabled style={styles.options} contentContainerStyle={styles.field}>
              {control.options.map((o) => {
                const selected = draft[control.id] === o.id;
                return (
                  <Pressable
                    key={o.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled }}
                    disabled={disabled}
                    onPress={() => onChange(control.id, o.id)}
                    style={[styles.option, selected && styles.optionSelected]}
                  >
                    <Text style={selected ? styles.label : styles.body}>{o.label}</Text>
                  </Pressable>
                );
              })}
              </ScrollView>
            </View>
          );
        }
        if (control.kind === "toggle")
          return (
            <View key={control.id} style={styles.option}>
              <Text style={styles.body}>{control.label}</Text>
              <Switch
                accessibilityLabel={control.label}
                value={draft[control.id] === true}
                disabled={disabled}
                onValueChange={(v) => onChange(control.id, v)}
              />
            </View>
          );
        return null;
      })}
      {buttons.length > 0 ? (
        <View style={styles.field}>
          {terminal ? null : <Text style={styles.note}>{t("interaction.inputHandoff.screenActions")}</Text>}
          {buttons.map((button) => (
            <MainWindowActionButton
              key={button.id}
              action={{
                label: button.label || t("interaction.inputHandoff.unnamedButton"),
                disabled,
                tone: button.primary ? "primary" : "secondary",
                onPress: () => onSubmit({ kind: "press", controlId: button.id }),
              }}
            />
          ))}
        </View>
      ) : null}
      {snapshot.controls.every((c) => c.kind === "note") ? (
        <Text style={styles.note}>{t("interaction.inputHandoff.nothingToFill")}</Text>
      ) : null}
      <MainWindowActionGroup
        density="compact"
        cancelAction={{ label: t("interaction.inputHandoff.action.cancel"), disabled: busy, onPress: () => onDecide("cancel") }}
        secondaryActions={[
          ...(terminal
            ? []
            : [{ label: t("interaction.inputHandoff.action.refresh"), disabled: busy, tone: "secondary" as const, onPress: () => onDecide("refresh") }]),
          ...(terminal
            ? []
            : [{ label: t("interaction.inputHandoff.action.picture"), disabled: busy, tone: "secondary" as const, onPress: () => onDecide("picture") }]),
          { label: t("interaction.inputHandoff.action.decline"), disabled: busy, tone: "secondary", onPress: () => onDecide("decline") },
        ]}
        primaryActions={footer}
      />
    </View>
  );
}

function unnamedFieldKey(contentType: string): string {
  if (contentType === "password") return "interaction.inputHandoff.passwordField";
  if (contentType === "one-time-code") return "interaction.inputHandoff.codeField";
  return "interaction.inputHandoff.unnamedField";
}

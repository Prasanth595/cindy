import type {
  InputHandoffContentType,
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from "@cindy/device-link";
import type { TextInputProps } from "react-native";

/**
 * Standard platform hints per field so iOS AutoFill / Android Autofill and
 * password managers (1Password) offer the right item. Password fields are
 * the plain system secure field — no custom reveal.
 */
export function nativeTextInputProps(
  contentType: InputHandoffContentType,
): Pick<
  TextInputProps,
  "secureTextEntry" | "textContentType" | "autoComplete" | "keyboardType"
> {
  switch (contentType) {
    case "password":
      return {
        secureTextEntry: true,
        textContentType: "password",
        autoComplete: "password",
      };
    case "one-time-code":
      return {
        textContentType: "oneTimeCode",
        autoComplete: "sms-otp",
        keyboardType: "number-pad",
      };
    case "username":
      return { textContentType: "username", autoComplete: "username" };
    case "email":
      return {
        textContentType: "emailAddress",
        autoComplete: "email",
        keyboardType: "email-address",
      };
    case "tel":
      return {
        textContentType: "telephoneNumber",
        autoComplete: "tel",
        keyboardType: "phone-pad",
      };
    case "url":
      return { textContentType: "URL", autoComplete: "url", keyboardType: "url" };
    case "number":
      return { textContentType: "none", autoComplete: "off", keyboardType: "number-pad" };
    default:
      return { textContentType: "none", autoComplete: "off" };
  }
}

type Interactive = Exclude<InputHandoffControl, { kind: "note" }>;

const interactive = (snapshot: InputHandoffSnapshot): Interactive[] =>
  snapshot.controls.filter((c): c is Interactive => c.kind !== "note");

/** Choices start at the screen's selection, toggles at their state; text empty. */
export function initialInputHandoffDraft(
  snapshot: InputHandoffSnapshot,
): InputHandoffValues {
  const draft: InputHandoffValues = {};
  for (const control of snapshot.controls) {
    if (control.kind === "choice" && control.selected)
      draft[control.id] = control.selected;
    if (control.kind === "toggle") draft[control.id] = control.checked;
  }
  return draft;
}

/** Only values the owner changed are applied to the screen. */
export function changedInputHandoffValues(
  snapshot: InputHandoffSnapshot,
  draft: InputHandoffValues,
): InputHandoffValues {
  const initial = initialInputHandoffDraft(snapshot);
  const out: InputHandoffValues = {};
  for (const control of interactive(snapshot)) {
    const value = draft[control.id];
    if (value === undefined) continue;
    if (control.kind === "text" && value === "") continue;
    if (control.kind !== "text" && value === initial[control.id]) continue;
    out[control.id] = value;
  }
  return out;
}

export function parseInputHandoffSnapshotLike(
  raw: Record<string, unknown>,
): InputHandoffSnapshot | null {
  const source = raw.source as Record<string, unknown> | undefined;
  if (
    raw.kind !== "input_handoff" ||
    typeof raw.requestId !== "string" ||
    !Number.isSafeInteger(raw.revision) ||
    typeof raw.purpose !== "string" ||
    !Array.isArray(raw.controls) ||
    !source ||
    typeof source.app !== "string"
  )
    return null;
  return raw as unknown as InputHandoffSnapshot;
}

/**
 * 代输入 card on the phone. The Host reads one screen of the target UI; the
 * owner answers it with standard native fields (system secure field +
 * AutoFill hints so 1Password / Passwords can fill them). Typed values stay in
 * this component and leave only through the sealed per-step channel.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  InputHandoffAction,
  InputHandoffSnapshot,
  InputHandoffValues,
} from "@cindy/device-link";
import {
  inputHandoffHeldElsewhere,
  inputHandoffStepKey,
} from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import { Text } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowActionGroup,
} from "@/components/MobilePrimitives";
import { useRemoteDeviceIdentity } from "@/session/remoteSessionStore";
import { useTheme, useThemedStyles } from "@/theme";
import { useGuardedPush } from "@/utils/useGuardedPush";
import {
  InputHandoffPictureStep,
  rememberInputHandoffPictureOpened,
} from "./InputHandoffPictureStep";
import { InputHandoffDeviceCode } from "./InputHandoffDeviceCode";
import { InputHandoffStepFields } from "./InputHandoffStepFields";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import {
  changedInputHandoffValues,
  initialInputHandoffDraft,
} from "./inputHandoffNative";
import { useInputHandoffSubmit } from "./useInputHandoffSubmit";

type Decision =
  "done" | "cancel" | "stay" | "refresh" | "claim" | "decline" | "picture";

export function InputHandoffCard({
  deviceId,
  snapshot,
  decisionBusy,
  onDecision,
  onQuietDecision,
}: {
  deviceId: string;
  snapshot: InputHandoffSnapshot;
  decisionBusy: boolean;
  onDecision(decision: Record<string, unknown>): void;
  /** Background decision that never marks the card busy (quiet claim). */
  onQuietDecision?(decision: Record<string, unknown>): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const handoff = useInputHandoffSubmit(deviceId);
  const selfDeviceId = useAuth().deviceId;
  const heldElsewhere = inputHandoffHeldElsewhere(snapshot, {
    deviceId: selfDeviceId,
  });
  const stepKey = inputHandoffStepKey(snapshot);
  const started = useRef(false);
  const [draft, setDraft] = useState<InputHandoffValues>(() =>
    initialInputHandoffDraft(snapshot),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every new screen starts from a clean draft; stale values are never reused.
  // Holder changes on the same screen keep what the owner is typing.
  useEffect(() => {
    setDraft(initialInputHandoffDraft(snapshot));
    setError(null);
    started.current = false;
  }, [stepKey]);
  const change = (id: string, value: string | boolean) => {
    // Starting to type on an unheld screen takes the handoff quietly.
    if (!started.current) {
      started.current = true;
      if (!snapshot.holder)
        onQuietDecision?.({
          kind: "input_handoff",
          action: "claim",
          expectedRevision: snapshot.revision,
        });
    }
    setDraft((d) => ({ ...d, [id]: value }));
  };

  const busy = decisionBusy || sending;
  const decide = (action: Decision) => {
    if (action === "picture")
      rememberInputHandoffPictureOpened(snapshot.requestId);
    onDecision({
      kind: "input_handoff",
      action,
      expectedRevision: snapshot.revision,
    });
  };
  const submit = async (action: InputHandoffAction) => {
    if (busy || snapshot.remoteInput !== true) return;
    setSending(true);
    setError(null);
    const values = changedInputHandoffValues(snapshot, draft);
    try {
      await handoff.submit(snapshot, {
        expectedRevision: snapshot.revision,
        values,
        action,
      });
      setDraft({});
    } catch (e) {
      setError(
        e instanceof Error && e.message === "INPUT_HANDOFF_STALE"
          ? t("interaction.inputHandoff.error.stale")
          : t("interaction.inputHandoff.error.submit"),
      );
    } finally {
      setSending(false);
    }
  };

  const { source } = snapshot;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("interaction.inputHandoff.title")}</Text>
        {!snapshot.terminal ? (
          <Text style={styles.meta}>
            {t("interaction.inputHandoff.step", { count: snapshot.stepNumber })}
          </Text>
        ) : null}
      </View>
      <Text style={styles.body}>{snapshot.purpose}</Text>
      {snapshot.note ? (
        <Text style={styles.body}>
          {t("interaction.inputHandoff.agentNote", { note: snapshot.note })}
        </Text>
      ) : null}
      {snapshot.requester ? (
        <Text style={styles.meta}>
          {t("interaction.inputHandoff.requester", {
            name: snapshot.requester,
          })}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {[source.app, source.window].filter(Boolean).join(" · ")}
      </Text>
      {source.origin ? <Text style={styles.mono}>{source.origin}</Text> : null}
      {snapshot.command ? (
        <Text style={styles.mono}>{snapshot.command}</Text>
      ) : null}
      {source.warning ? (
        <Text style={styles.warning}>
          {t(`interaction.inputHandoff.originWarning.${source.warning}`)}
        </Text>
      ) : null}
      {snapshot.agentControlled ? (
        <Text style={styles.warning}>
          {t("interaction.inputHandoff.agentControlled")}
        </Text>
      ) : null}
      {snapshot.failure && !snapshot.terminal ? (
        <Text style={styles.note}>
          {t(`interaction.inputHandoff.failure.${snapshot.failure}`)}
        </Text>
      ) : null}
      {snapshot.terminal ? (
        <Text style={styles.body}>
          {t(
            snapshot.phase === "failed" && snapshot.failure
              ? `interaction.inputHandoff.failure.${snapshot.failure}`
              : `interaction.inputHandoff.terminal.${snapshot.phase}`,
          )}
        </Text>
      ) : snapshot.phase === "ready" && heldElsewhere ? (
        <>
          <Text style={styles.body}>
            {t("interaction.inputHandoff.holder.elsewhere", {
              device: holderLabel(snapshot, t),
            })}
          </Text>
          <MainWindowActionGroup
            density="compact"
            cancelAction={{
              label: t("interaction.inputHandoff.action.cancel"),
              disabled: busy,
              onPress: () => decide("cancel"),
            }}
            primaryActions={[
              {
                label: t("interaction.inputHandoff.action.claim"),
                disabled: busy,
                tone: "primary",
                onPress: () => decide("claim"),
              },
            ]}
          />
        </>
      ) : snapshot.phase === "ready" && snapshot.picture ? (
        // One screenshot per revision; no quiet claim here (it would bump the revision).
        <InputHandoffPictureStep
          key={`${snapshot.requestId}:${snapshot.revision}`}
          snapshot={snapshot}
          busy={busy}
          openPicture={handoff.openPicture}
          onDecide={decide}
          onError={setError}
        />
      ) : snapshot.phase === "ready" ? (
        <>
          <InputHandoffDeviceCode snapshot={snapshot} />
          <InputHandoffStepFields
            snapshot={snapshot}
            draft={draft}
            disabled={busy || snapshot.remoteInput !== true}
            busy={busy}
            onChange={change}
            onSubmit={(action) => void submit(action)}
            onDecide={decide}
          />
        </>
      ) : snapshot.phase === "finishing" ? (
        <>
          <FinishingText until={snapshot.finishingUntil} style={styles.body} />
          <MainWindowActionGroup
            density="compact"
            secondaryActions={[
              {
                label: t("interaction.inputHandoff.action.stay"),
                disabled: busy,
                onPress: () => decide("stay"),
              },
            ]}
            primaryActions={[
              {
                label: t("interaction.inputHandoff.action.done"),
                disabled: busy,
                tone: "primary",
                onPress: () => decide("done"),
              },
            ]}
          />
        </>
      ) : (
        <>
          <View style={styles.row}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.body}>
              {t(
                snapshot.phase === "working"
                  ? "interaction.inputHandoff.phase.working"
                  : "interaction.inputHandoff.phase.reading",
              )}
            </Text>
          </View>
          <MainWindowActionButton
            density="compact"
            action={{
              label: t("interaction.inputHandoff.action.cancel"),
              disabled: busy,
              tone: "secondary",
              onPress: () => decide("cancel"),
            }}
          />
        </>
      )}
      {error ? <Text style={styles.note}>{error}</Text> : null}
      {snapshot.liveView && !snapshot.terminal ? (
        <InputHandoffLiveView
          deviceId={deviceId}
          requestId={snapshot.requestId}
        />
      ) : null}
    </View>
  );
}

/**
 * Opens a live view of just the target window on the computer running the
 * task. Navigation only: the computer picks the window from the request id and
 * keeps taps and typing inside it; the phone never names a window.
 */
function InputHandoffLiveView({
  deviceId,
  requestId,
}: {
  deviceId: string;
  requestId: string;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const push = useGuardedPush();
  const devices = useRemoteDeviceIdentity();
  const deviceName =
    devices.find((device) => device.deviceId === deviceId)?.name || deviceId;
  return (
    <View style={styles.liveView}>
      <Text style={styles.meta}>
        {t("interaction.inputHandoff.liveViewHint")}
      </Text>
      <MainWindowActionButton
        density="compact"
        action={{
          label: t("interaction.inputHandoff.action.liveView"),
          tone: "secondary",
          testID: "interaction.inputHandoff.liveView",
          onPress: () =>
            push({
              pathname: "/devices/desktop/[deviceId]",
              params: { deviceId, deviceName, handoff: requestId },
            }),
        }}
      />
    </View>
  );
}

function holderLabel(
  snapshot: InputHandoffSnapshot,
  t: (key: string) => string,
): string {
  const holder = snapshot.holder;
  if (holder?.local) return t("interaction.inputHandoff.holder.host");
  if (holder?.name) return holder.name;
  return t(
    holder?.platform === "mobile"
      ? "interaction.inputHandoff.holder.phone"
      : "interaction.inputHandoff.holder.otherDevice",
  );
}

function FinishingText({ until, style }: { until?: number; style: object }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  const seconds = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return (
    <Text style={style}>
      {until
        ? t("interaction.inputHandoff.phase.finishing", { count: seconds })
        : t("interaction.inputHandoff.phase.finishingNow")}
    </Text>
  );
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import type { AgentKind } from "@cindy/model-providers/types";

// Device-local acknowledgement, shared by the new-task and existing-task pickers.
const STORAGE_KEY = "cindy.mobile.claude-fast-mode-warning.dismissed.v1";
type FastMode = boolean | "ultrafast";

export interface ClaudeFastModeConfirmation {
  dontShowAgain: boolean;
  saving: boolean;
  onDontShowAgain(value: boolean): void;
  onCancel(): void;
  onConfirm(): void;
}

/** Hold the actual option change until the billing warning has been accepted. */
export function useClaudeFastModeConfirmation(scope: string | null) {
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const requestId = useRef(0);
  const [pending, setPending] = useState<{
    scope: string;
    apply(): void;
  } | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const busy = useRef(false);

  const cancel = () => {
    requestId.current += 1;
    busy.current = false;
    setPending(null);
    setDontShowAgain(false);
    setSaving(false);
    setReading(false);
  };
  useEffect(() => {
    cancel();
    return () => {
      requestId.current += 1;
    };
  }, [scope]);

  const request = (
    agent: AgentKind,
    current: FastMode,
    next: FastMode,
    apply: () => void,
  ) => {
    if (agent !== "claude-code" || current || !next) {
      apply();
      return;
    }
    if (!scope || busy.current) return;
    busy.current = true;
    setReading(true);
    const id = ++requestId.current;
    void AsyncStorage.getItem(STORAGE_KEY)
      .catch(() => null)
      .then((value) => {
        if (requestId.current !== id || currentScope.current !== scope) return;
        setReading(false);
        if (value === "1") {
          busy.current = false;
          apply();
        } else {
          setDontShowAgain(false);
          setPending({ scope, apply });
        }
      });
  };
  const confirm = () => {
    if (!pending || saving || pending.scope !== currentScope.current) return;
    const id = requestId.current;
    setSaving(true);
    // A failed preference write leaves the warning enabled next time, but does
    // not revoke this explicit confirmation to enable Fast mode.
    const write = dontShowAgain
      ? AsyncStorage.setItem(STORAGE_KEY, "1").catch(() => undefined)
      : Promise.resolve();
    void write.then(() => {
      if (requestId.current !== id || pending.scope !== currentScope.current)
        return;
      cancel();
      pending.apply();
    });
  };
  const warning: ClaudeFastModeConfirmation | null =
    pending?.scope === scope
      ? {
          dontShowAgain,
          saving,
          onDontShowAgain: setDontShowAgain,
          onCancel: cancel,
          onConfirm: confirm,
        }
      : null;
  return { request, warning, reading };
}

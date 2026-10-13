// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { InputHandoffSnapshot } from "@cindy/device-link";

const push = vi.fn();
const openURL = vi.fn(async () => true);
const setStringAsync = vi.fn(async () => true);
vi.mock("expo-clipboard", () => ({ setStringAsync }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: box,
    Text: box,
    ActivityIndicator: () => null,
    Linking: { openURL },
    StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", async () => ({ Text: (await import("react-native")).Text }));
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { label: string; disabled?: boolean; onPress(): void };
  const button = (action: Action) =>
    createElement(
      "button",
      { key: action.label, disabled: action.disabled, onClick: action.onPress },
      action.label,
    );
  return {
    MainWindowActionButton: ({ action }: { action: Action }) => button(action),
    MainWindowActionGroup: ({ primaryActions = [] }: { primaryActions?: Action[] }) =>
      createElement("div", null, ...primaryActions.map(button)),
  };
});
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock("@/inputHandoff/inputHandoffStyles", () => ({ makeInputHandoffStyles: () => ({}) }));
vi.mock("@/inputHandoff/InputHandoffStepFields", () => ({ InputHandoffStepFields: () => null }));
vi.mock("@/inputHandoff/InputHandoffPictureStep", () => ({
  InputHandoffPictureStep: () => null,
  rememberInputHandoffPictureOpened: () => {},
}));
vi.mock("@/inputHandoff/useInputHandoffSubmit", () => ({
  useInputHandoffSubmit: () => ({ submit: vi.fn(), openPicture: vi.fn() }),
}));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ deviceId: "phone" }) }));
vi.mock("@/session/remoteSessionStore", () => ({
  useRemoteDeviceIdentity: () => [{ deviceId: "mac", name: "Studio" }],
}));
vi.mock("@/utils/useGuardedPush", () => ({ useGuardedPush: () => push }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { InputHandoffCard } = await import("@/inputHandoff/InputHandoffCard");

let roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  push.mockClear();
  openURL.mockClear();
  setStringAsync.mockClear();
});

const step = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: "input_handoff",
  requestId: "req1",
  revision: 2,
  phase: "ready",
  purpose: "Sign in",
  source: { app: "Game" },
  stepNumber: 1,
  remoteInput: true,
  controls: [],
  ...overrides,
});

function mount(snapshot: InputHandoffSnapshot) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(InputHandoffCard, {
        deviceId: "mac",
        snapshot,
        decisionBusy: false,
        onDecision: () => {},
      }),
    );
  });
  return container;
}
const liveButton = (container: Element) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "interaction.inputHandoff.action.liveView",
  );

it("opens a live view of just this window on the computer running the task", async () => {
  expect(liveButton(mount(step()))).toBeUndefined();
  expect(
    liveButton(mount(step({ liveView: true, phase: "cancelled", terminal: true }))),
  ).toBeUndefined();
  const container = mount(step({ liveView: true }));
  await act(async () => liveButton(container)!.click());
  expect(push).toHaveBeenCalledWith({
    pathname: "/devices/desktop/[deviceId]",
    params: { deviceId: "mac", deviceName: "Studio", handoff: "req1" },
  });
});

const buttonNamed = (container: Element, label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

it("offers a sign-in code to copy and its link to open on this phone", async () => {
  const deviceCode = {
    code: "WDJB-MJHT",
    url: "https://github.com/login/device",
    origin: "https://github.com",
  };
  const container = mount(step({ deviceCode }));
  expect(container.textContent).toContain("WDJB-MJHT");
  await act(async () =>
    buttonNamed(container, "interaction.inputHandoff.deviceCode.copy")!.click(),
  );
  expect(setStringAsync).toHaveBeenCalledWith("WDJB-MJHT");
  expect(container.textContent).toContain("interaction.inputHandoff.deviceCode.copied");
  await act(async () =>
    buttonNamed(container, "interaction.inputHandoff.deviceCode.open")!.click(),
  );
  expect(openURL).toHaveBeenCalledWith("https://github.com/login/device");
  // A link whose shown origin does not match is never offered.
  const forged = mount(step({ deviceCode: { ...deviceCode, origin: "https://example.com" } }));
  expect(buttonNamed(forged, "interaction.inputHandoff.deviceCode.open")).toBeUndefined();
});

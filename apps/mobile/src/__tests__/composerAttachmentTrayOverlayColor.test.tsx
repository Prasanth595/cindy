// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerAttachmentCollapsedBadge,
  ComposerAttachmentTray,
} from "@/session/ComposerAttachmentTray";
import { i18n } from "@/i18n";
import type { RemoteSerializedAttachment } from "@/session/types";
import type { PendingLocalAttachmentUpload } from "@/session/mobileLocalAttachmentUpload";

const theme = vi.hoisted(() => ({ mode: "light" }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : style && typeof style === "object"
        ? (style as Record<string, unknown>)
        : {};
  const view =
    (tag: string) =>
    ({
      children,
      style,
      testID,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
    }) =>
      createElement(
        tag,
        {
          "data-testid": testID,
          "data-color": flatten(
            typeof style === "function" ? style({ pressed: false }) : style,
          ).color,
        },
        children,
      );
  return {
    View: view("div"),
    Pressable: view("button"),
    Text: view("span"),
    ActivityIndicator: ({ color }: { color: string }) =>
      createElement("i", { "data-testid": "spinner", "data-color": color }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("@/components/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("lucide-react-native", async () => {
  const { createElement } = await import("react");
  const icon =
    (name: string) =>
    ({ color }: { color: string }) =>
      createElement("i", { "data-testid": name, "data-color": color });
  return { Pen: icon("pen"), RefreshCw: icon("retry-icon"), X: icon("x") };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = () =>
    theme.mode === "light" ? tokens.lightColors : tokens.darkColors;
  return {
    ...tokens,
    useTheme: () => ({ colors: colors(), mode: theme.mode }),
    useThemedStyles: (make: (value: typeof tokens.lightColors) => unknown) =>
      make(colors()),
  };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage("zh-CN");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
});

const pending = (
  localId: string,
  failed?: boolean,
): PendingLocalAttachmentUpload => ({
  localId,
  kind: "image",
  previewUri: `file:///${localId}.jpg`,
  name: `${localId}.jpg`,
  size: 1,
  failed,
});
const attachment = (id: string): RemoteSerializedAttachment => ({
  id,
  name: `${id}.jpg`,
  path: `/tmp/${id}.jpg`,
  ext: "jpg",
  size: 1,
  category: "image",
  mimeType: "image/jpeg",
});
const colorOf = (selector: string) =>
  host.querySelector(selector)?.getAttribute("data-color");

describe("composer attachment tray overlay foreground", () => {
  // 遮罩 scrim 两种模式都是深色:前景必须恒白,不能跟着主题反相成近黑。
  it.each(["light", "dark"])(
    "keeps spinner, retry and +N readable on the dark scrim in %s mode",
    async (mode) => {
      theme.mode = mode;
      const { darkColors, lightColors } = await import("@/theme/tokens");
      const colors = mode === "light" ? lightColors : darkColors;
      act(() =>
        root.render(
          <>
            <ComposerAttachmentTray
              attachments={[]}
              previews={{}}
              onRemove={() => {}}
              onPreview={() => {}}
              pendingUploads={[pending("uploading"), pending("failed", true)]}
              testIDPrefix="t"
            />
            <ComposerAttachmentCollapsedBadge
              attachments={[attachment("a"), attachment("b")]}
              previews={{ a: "file:///a.jpg" }}
              onPress={() => {}}
            />
          </>,
        ),
      );
      expect(colorOf('[data-testid="spinner"]')).toBe(colors.swipeActionText);
      expect(colorOf('[data-testid="retry-icon"]')).toBe(
        colors.swipeActionText,
      );
      const retryText = [...host.querySelectorAll("span")].find(
        (node) => node.textContent === i18n.t("composer.attachments.retry"),
      );
      expect(retryText?.getAttribute("data-color")).toBe(
        colors.swipeActionText,
      );
      const plusN = [...host.querySelectorAll("span")].find(
        (node) => node.textContent === "+1",
      );
      expect(plusN?.getAttribute("data-color")).toBe(colors.swipeActionText);
      expect(colors.swipeActionText).not.toBe(darkColors.ctaText);
    },
  );
});

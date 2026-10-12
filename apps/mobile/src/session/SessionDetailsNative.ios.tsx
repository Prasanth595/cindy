import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Button,
  Divider,
  Group,
  HStack,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  contentShape,
  disabled,
  foregroundStyle,
  frame,
  labelStyle,
  lineLimit,
  padding,
  presentationDetents,
  presentationDragIndicator,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, spacing, useTheme } from "@/theme";
import { useMobileKeyboardState } from "./useMobileKeyboardState";
import type {
  SessionDetailsAction,
  SessionDetailsNativeProps,
} from "./SessionDetailsNative";

export function SessionDetailsNative({
  visible,
  title,
  backLabel,
  onClose,
  onClosed,
  onBack,
  children,
  footer,
  contentPaddingTop = spacing.lg,
}: SessionDetailsNativeProps) {
  const { colors, mode } = useTheme();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const keyboardOverlap = useKeyboardOverlap(!!footer && visible);
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      pointerEvents="none"
      style={{ position: "absolute" }}
    >
      <BottomSheet
        isPresented={visible}
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
        onDismiss={onClosed}
      >
        <Group
          modifiers={[
            presentationDetents(["medium", "large"], { selection: "medium" }),
            presentationDragIndicator("visible"),
          ]}
        >
          <VStack
            spacing={0}
            modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}
          >
            <SessionDetailsNativeHeading title={title} backLabel={backLabel} onBack={onBack} />
            {/* Extend the viewport through the sheet's bottom safe area. Keep the
                inset inside scroll content, not as an empty strip below its clip. */}
            <Group modifiers={[padding({ bottom: footer ? 0 : -bottomInset })]}>
              <RNHostView>
                <View ref={keyboardOverlap.ref} onLayout={keyboardOverlap.measure} style={{ flex: 1 }}>
                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{
                      padding: spacing.lg,
                      paddingTop: contentPaddingTop,
                      paddingBottom: spacing.xxl + (footer ? 0 : bottomInset),
                    }}
                  >
                    {children}
                  </ScrollView>
                  {footer ? (
                    <View style={{ padding: spacing.lg, paddingBottom: spacing.lg + keyboardOverlap.overlap }}>
                      {footer}
                    </View>
                  ) : null}
                </View>
              </RNHostView>
            </Group>
          </VStack>
        </Group>
      </BottomSheet>
    </Host>
  );
}

/**
 * 底部按钮被键盘挡住的高度。SwiftUI sheet 对内嵌 RN 内容的键盘避让不完整,底部
 * 按钮会被键盘盖住一截;这里按实际位置补齐:量内容区在窗口里的底边,与键盘顶边比较。
 * 量的是外层容器,尺寸不受补出的 padding 影响,不会来回抖动。
 */
function useKeyboardOverlap(enabled: boolean) {
  const ref = useRef<View>(null);
  const keyboard = useMobileKeyboardState();
  const { height: windowHeight } = useWindowDimensions();
  const [bottom, setBottom] = useState<number | null>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _width, height) => setBottom(y + height));
  }, []);
  useEffect(() => {
    if (!enabled || !keyboard.visible) return;
    measure();
    // sheet 跟随键盘移动、展开的动画结束后再量一次,以最终位置为准。
    const timer = setTimeout(measure, 400);
    return () => clearTimeout(timer);
  }, [enabled, keyboard.height, keyboard.visible, measure]);
  const overlap = enabled && keyboard.visible && bottom !== null
    ? Math.max(0, Math.ceil(bottom - (windowHeight - keyboard.height)))
    : 0;
  return { ref, measure, overlap };
}

export function SessionDetailsNativeActions({
  actions,
}: {
  actions: SessionDetailsAction[];
}) {
  const { colors, mode } = useTheme();
  const [width, setWidth] = useState(0);
  if (!actions.length) return null;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", paddingTop: spacing.lg }}
    >
      {width > 0 ? (
        <Host
          key={width}
          colorScheme={mode}
          matchContents={{ vertical: true }}
          style={{ width }}
        >
          <VStack
            spacing={0}
            modifiers={[
              frame({ width }),
              background(
                colors.surfaceTranslucent,
                shapes.roundedRectangle({ cornerRadius: radius.container }),
              ),
            ]}
          >
            {actions.map((action, index) => (
              <Group key={action.testID}>
                {index > 0 ? (
                  <Divider modifiers={[padding({ leading: spacing.lg })]} />
                ) : null}
                <Button
                  onPress={action.onPress}
                  testID={action.testID}
                  modifiers={[
                    buttonStyle("plain"),
                    disabled(!!action.disabled),
                  ]}
                >
                  <Text
                    modifiers={[
                      foregroundStyle(
                        action.danger ? colors.destructive : colors.textPrimary,
                      ),
                      frame({ minHeight: 48 }),
                      frame({
                        width: Math.max(0, width - spacing.lg * 2),
                        alignment: "leading",
                      }),
                      padding({ leading: spacing.lg, trailing: spacing.lg }),
                      // Apply after sizing the label so empty row space receives taps too.
                      contentShape(shapes.rectangle()),
                    ]}
                  >
                    {action.label}
                  </Text>
                </Button>
              </Group>
            ))}
          </VStack>
        </Host>
      ) : null}
    </View>
  );
}

export function SessionDetailsNativeHeading({
  title,
  backLabel,
  onBack,
}: Pick<SessionDetailsNativeProps, 'title' | 'backLabel' | 'onBack'>) {
  const glassStyle = useNativeGlassButtonStyle({ shape: 'circle' });
  return (
    <HStack
      modifiers={[
        padding({
          top: spacing.lg,
          bottom: spacing.sm,
          leading: spacing.lg,
          trailing: spacing.lg,
        }),
      ]}
    >
      {onBack ? (
        <Button
          label={backLabel}
          systemImage="chevron.backward"
          onPress={onBack}
          modifiers={[
            labelStyle('iconOnly'),
            ...glassStyle,
            frame({ width: 44, height: 44 }),
          ]}
        />
      ) : (
        <Spacer modifiers={[frame({ width: 44 })]} />
      )}
      <Spacer />
      <Text modifiers={[lineLimit(1)]}>{title}</Text>
      <Spacer />
      <Spacer modifiers={[frame({ width: 44, height: 44 })]} />
    </HStack>
  );
}

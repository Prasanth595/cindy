import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GeometryContext, PaneViewportProvider, usePaneViewport } from '@/platform/AdaptiveWindowContext';
import { RecentMessageHistoriesProvider } from './RecentMessageHistories';
import { NativeBottomSheet } from './NativeBottomSheet';
import { useMobileKeyboardState } from './useMobileKeyboardState';
import { remoteSessionStore } from './remoteSessionStore';
import { goBackGuarded } from '@/utils/backGuard';

const DismissContext = createContext<(() => void) | null>(null);
export const useSideChatDismiss = () => useContext(DismissContext);

/** Native presentation owns the sheet and dismissal. Keep the existing task content,
 * resident message host and composer geometry inside that native surface. */
export function SideChatPresentation({ children, deviceId, sessionId }: {
  children: ReactNode;
  deviceId: string;
  sessionId: string;
}) {
  const router = useRouter();
  const focused = useIsFocused();
  const [visible, setVisible] = useState(true);
  const [removed, setRemoved] = useState(false);
  const [closed, setClosed] = useState(false);
  const returned = useRef(false);
  const show = visible && focused && !removed;
  useEffect(() => remoteSessionStore.onSessionRemoved((ownerDeviceId, removedSessionId) => {
    if (ownerDeviceId === deviceId && removedSessionId === sessionId) setRemoved(true);
  }), [deviceId, sessionId]);
  useEffect(() => { if (show) setClosed(false); }, [show]);
  useEffect(() => {
    if (!focused || (visible && !removed) || returned.current) return;
    Keyboard.dismiss();
    // Android must finish native dismissal before removing the route. A hidden
    // route waits until focus returns, so deletion cannot pop a different screen.
    if (Platform.OS === 'android' && !closed) return;
    returned.current = true;
    goBackGuarded(router);
  }, [closed, focused, removed, router, visible]);
  // Android resident histories live above the navigation stack. Its existing
  // native dialog sheet owns a higher window, so the main task can stay visible.
  if (Platform.OS === 'android') return <DismissContext.Provider value={() => setVisible(false)}>
    <NativeBottomSheet visible={show} onClose={() => setVisible(false)}
      onClosed={() => setClosed(true)}>
      <SideChatViewport fixedHeight>{children}</SideChatViewport>
    </NativeBottomSheet>
  </DismissContext.Provider>;
  return <SideChatViewport>{children}</SideChatViewport>;
}

function SideChatViewport({ children, fixedHeight = false }: { children: ReactNode; fixedHeight?: boolean }) {
  const window = useWindowDimensions();
  const pane = usePaneViewport();
  const keyboard = useMobileKeyboardState(fixedHeight);
  const safe = useSafeAreaInsets();
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const viewport = measured ?? { width: window.width, height: window.height * 0.85 };
  const insets = useMemo(() => ({ ...safe, top: 0 }), [safe]);
  const geometry = useMemo(() => ({ ...viewport, insets,
    regularWidth: false, regularHeight: viewport.height >= 600,
    barEdge: 'none' as const, regions: [], reservedRegionsSupported: false,
  }), [viewport.width, viewport.height, insets]);
  // Material owns IME positioning; shrink the content once so the header stays
  // visible instead of letting the dialog pan a full-height editor offscreen.
  const height = fixedHeight ? Math.min(pane.height, (window.height - keyboard.height) * 0.85) : undefined;
  return <View style={fixedHeight ? { height } : styles.fill} onLayout={({ nativeEvent: { layout } }) => {
    if (layout.width > 0 && layout.height > 0) setMeasured(previous =>
      previous?.width === layout.width && previous.height === layout.height
        ? previous : { width: layout.width, height: layout.height });
  }}>
    <SafeAreaInsetsContext.Provider value={insets}>
      <GeometryContext.Provider value={geometry}>
        <PaneViewportProvider value={viewport}>
          <RecentMessageHistoriesProvider>{children}</RecentMessageHistoriesProvider>
        </PaneViewportProvider>
      </GeometryContext.Provider>
    </SafeAreaInsetsContext.Provider>
  </View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

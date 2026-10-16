import { useHomeMode } from './useHomeMode';
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { HomeModeProgressContext, useHomeModeProgress } from './HomeModeTransition';
import { useSegments } from 'expo-router';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';
import { RemoteSessionStoreSubscriptionGate } from './remoteSessionStore';
import { sessionPaneLayout } from './sessionPaneLayout';

type Frame = { left: number; top: number; width: number; height: number };
/** 常驻任务列表只有一个可见槽位:整宽首页,或任务页侧栏。 */
export type ResidentHomeSlot = 'home' | 'sidebar';
/**
 * 当前路由让哪一侧槽位可见:首页路由给整宽首页,任务路由给侧栏,其余路由两侧都不可见。
 * 侧栏在任务页里归属会话路由,所以用 `sessions/[sessionId]` 判定;与下面 `visible` 同源。
 */
export function visibleResidentHomeSlot(segments: readonly string[]): ResidentHomeSlot | null {
  if (segments[0] === 'sessions' && segments[1] === '[sessionId]') return 'sidebar';
  if (segments.length === 0 || segments[0] === 'index'
    || (segments[0] === 'devices' && (segments.length === 1 || segments[1] === 'index'))) return 'home';
  return null;
}
type Entry = { owner: string; slot: ResidentHomeSlot; frame: Frame; children: ReactNode };
const Context = createContext<{
  enabled: boolean;
  mounted: { current: boolean };
  /** 当前可见槽位;为 null 时任何一侧都不允许发布。 */
  slot: ResidentHomeSlot | null;
  publish(entry: Entry): void;
  host: React.RefObject<View | null>;
} | null>(null);

export function useResidentHomeList() {
  const context = useContext(Context);
  return { enabled: context?.enabled ?? false, mounted: context?.mounted };
}

/** Preserve the resident-list owner when route content is re-hosted above this
 * provider. React context follows the render destination, so an explicit bridge
 * is required for Android root overlays that otherwise fall back to an inline
 * Home list. */
export function useResidentHomeListContextBridge(children: ReactNode) {
  const context = useContext(Context);
  return useMemo(
    () => <Context.Provider value={context}>{children}</Context.Provider>,
    [children, context],
  );
}

/** The list lives above route lifetimes. Owners only supply its frame and props;
 * never key the host by route, session, or presentation width. */
export function ResidentHomeListProvider({ children }: { children: ReactNode }) {
  const geometry = useAdaptiveWindow();
  const enabled = sessionPaneLayout(geometry).persistent;
  const segments = useSegments() as string[];
  const { mode, hydrated } = useHomeMode();
  const slot = visibleResidentHomeSlot(segments);
  const homeRoute = slot === 'home';
  const taskRoute = slot === 'sidebar';
  // Android pages draw their own bar inside each pane, so sliding them would move it; they switch in place.
  const progress = useHomeModeProgress(mode, homeRoute && Platform.OS === 'ios', hydrated);
  // Keep the outgoing resident list drawn during the slide, but never interactive over the new tab.
  const visible = enabled && ((mode === 'tasks' && homeRoute) || taskRoute);
  const slide = useAnimatedStyle(() => ({
    opacity: homeRoute ? (progress.value < 1 ? 1 : 0) : (visible ? 1 : 0),
    transform: [{ translateX: homeRoute ? -progress.value * geometry.width : 0 }],
  }));
  const host = useRef<View>(null);
  const mounted = useRef(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const reduceMotion = useReduceMotionEnabled();
  // 发布竞态闸门:一个槽位的测量可能在路由切换后才回来(隐藏首页/侧栏的迟到帧),
  // 谁不是当前可见槽位就丢掉谁的发布,避免常驻列表被错误宽度的帧接管。
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const publish = useCallback((next: Entry) => {
    if (next.slot !== slotRef.current) return;
    setEntry(next);
  }, []);
  const context = useMemo(() => ({ enabled, mounted, publish, host, slot }), [enabled, publish, host, slot]);
  useLayoutEffect(() => {
    mounted.current = enabled && !!entry;
    if (!enabled) setEntry(null);
  }, [enabled, entry]);
  return <HomeModeProgressContext.Provider value={progress}><Context.Provider value={context}>
    <View ref={host} collapsable={false} style={styles.root}>
      {children}
      {entry ? <Animated.View pointerEvents={visible ? 'box-none' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={[styles.host, entry.frame, {
          transitionProperty: ['left', 'top', 'width', 'height'],
          transitionDuration: reduceMotion === false ? motionDuration.fast : 0,
        }, slide]}>
        <RemoteSessionStoreSubscriptionGate enabled={visible}>{entry.children}</RemoteSessionStoreSubscriptionGate>
      </Animated.View> : null}
    </View>
  </Context.Provider></HomeModeProgressContext.Provider>;
}

/** A route supplies a measuring slot, not another native list. Its header stays
 * in the native navigation hierarchy, outside the list's touch bounds. Only the
 * slot the current route makes visible publishes; the other instance stays
 * mounted for the next route switch (full-width home ↔ session sidebar). */
export function ResidentHomeList({ children, focused, top, left, right, slot }: {
  children: ReactNode; focused: boolean; top: number; left: number; right: number;
  slot: ResidentHomeSlot;
}) {
  const context = useContext(Context);
  const owner = useId();
  const anchor = useRef<View>(null);
  const latest = useRef({ children, focused });
  latest.current = { children, focused };
  const ownsVisibleSlot = context?.slot === slot;
  const measureRevision = useRef(0);
  const measure = useCallback(() => {
    const revision = ++measureRevision.current;
    const host = context?.host.current;
    const anchorView = anchor.current;
    if (!context?.enabled || !ownsVisibleSlot || !latest.current.focused || !host || !anchorView) return;
    const publishFrame = (x: number, y: number, width: number, height: number) => {
      if (revision !== measureRevision.current || !latest.current.focused || width <= 0 || height <= 0) return;
      context.publish({ owner, slot, frame: { left: x, top: y, width, height }, children: latest.current.children });
    };
    // 抽屉在安卓上被重挂到根浮层(常驻列表宿主的兄弟位置),与宿主没有共同祖先,
    // measureLayout 会走 onFail;那时用两边窗口坐标的差值算帧。
    const measureInWindow = () => {
      anchorView.measureInWindow((x, y, width, height) => {
        host.measureInWindow((hostX, hostY) => publishFrame(x - hostX, y - hostY, width, height));
      });
    };
    try {
      anchorView.measureLayout(host, publishFrame, measureInWindow);
    } catch {
      measureInWindow();
    }
  }, [context, owner, slot, ownsVisibleSlot]);
  useLayoutEffect(() => {
    measure();
    return () => { ++measureRevision.current; };
  }, [measure, children, focused, top, left, right]);
  return <View ref={anchor} collapsable={false} pointerEvents="none" onLayout={measure}
    style={{ flex: 1, marginTop: top, marginLeft: -left, marginRight: -right }} />;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  host: { position: 'absolute' },
});

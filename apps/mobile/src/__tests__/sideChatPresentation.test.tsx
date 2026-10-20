// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatPresentation, useSideChatDismiss } from '../session/SideChatPresentation';

const state = vi.hoisted(() => ({
  platform: 'android',
  focused: true,
  back: vi.fn(),
  canGoBack: true,
  replace: vi.fn(),
  dismissKeyboard: vi.fn(),
  sheet: null as any,
  listeners: new Set<(deviceId: string, sessionId: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.platform; } },
  Keyboard: { dismiss: state.dismissKeyboard },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: any) => <div>{children}</div>,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({
  back: state.back, canGoBack: () => state.canGoBack, replace: state.replace,
}) }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused }));
vi.mock('react-native-safe-area-context', async () => {
  const { createContext } = await import('react');
  return {
    SafeAreaInsetsContext: createContext({ top: 0, bottom: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
  };
});
vi.mock('../platform/AdaptiveWindowContext', async () => {
  const { createContext } = await import('react');
  return {
    GeometryContext: createContext(null),
    PaneViewportProvider: ({ children }: any) => children,
    usePaneViewport: () => ({ width: 400, height: 800 }),
  };
});
vi.mock('../session/RecentMessageHistories', () => ({
  RecentMessageHistoriesProvider: ({ children }: any) => children,
}));
vi.mock('../session/useMobileKeyboardState', () => ({
  useMobileKeyboardState: () => ({ height: 0 }),
}));
vi.mock('../session/NativeBottomSheet', () => ({
  NativeBottomSheet: (props: any) => {
    state.sheet = props;
    return <div hidden={!props.visible}>{props.children}</div>;
  },
}));
vi.mock('../session/remoteSessionStore', () => ({
  remoteSessionStore: {
    onSessionRemoved: (listener: (deviceId: string, sessionId: string) => void) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
  },
}));

// Unit, black-box regression 2026-10-20: the live sheet kept its editor after
// desktop deletion. Picker/count tests do not mount this production presentation.
// Minimal input: its own removal signal followed by native onClosed. Observe
// visibility and navigation; substitute only native UI, router and store events.
describe('side chat presentation lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  function Editor() {
    const dismiss = useSideChatDismiss();
    return <button onClick={() => dismiss?.()}>collapse</button>;
  }
  const render = () => act(() => root.render(
    <SideChatPresentation deviceId="host" sessionId="child"><Editor /></SideChatPresentation>,
  ));
  const remove = (deviceId = 'host', sessionId = 'child') => act(() => {
    state.listeners.forEach(listener => listener(deviceId, sessionId));
  });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.platform = 'android';
    state.focused = true;
    state.sheet = null;
    state.back.mockClear();
    state.canGoBack = true;
    state.replace.mockClear();
    state.dismissKeyboard.mockClear();
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(state.listeners.size).toBe(0);
  });

  it('closes only its own sheet and returns once after native dismissal', () => {
    render();
    remove('other-host');
    remove('host', 'other-child');
    expect(state.sheet.visible).toBe(true);
    remove();
    expect(state.sheet.visible).toBe(false);
    expect(state.dismissKeyboard).toHaveBeenCalled();
    expect(state.back).not.toHaveBeenCalled();
    act(() => state.sheet.onClosed());
    expect(state.back).toHaveBeenCalledTimes(1);
    remove();
    act(() => state.sheet.onClosed());
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('does not pop a different screen when the removed route is unfocused', () => {
    render();
    state.focused = false;
    render();
    act(() => state.sheet.onClosed());
    remove();
    expect(state.back).not.toHaveBeenCalled();
    state.focused = true;
    render();
    expect(state.sheet.visible).toBe(false);
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('still waits for native dismissal when manually collapsing', () => {
    render();
    act(() => host.querySelector('button')!.click());
    expect(state.sheet.visible).toBe(false);
    expect(state.back).not.toHaveBeenCalled();
    act(() => state.sheet.onClosed());
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('returns the iOS route without waiting for an Android callback', () => {
    state.platform = 'ios';
    render();
    remove();
    expect(state.sheet).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
    remove();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('returns to Home when the closed sheet has no navigation history', () => {
    state.canGoBack = false;
    render();
    remove();
    act(() => state.sheet.onClosed());
    expect(state.back).not.toHaveBeenCalled();
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/');
  });
});

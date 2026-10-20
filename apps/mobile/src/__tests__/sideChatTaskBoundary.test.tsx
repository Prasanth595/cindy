// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatTaskBoundary } from '../session/SideChatTaskBoundary';

const state = vi.hoisted(() => ({
  focused: true,
  back: vi.fn(),
  canGoBack: true,
  replace: vi.fn(),
  dismissKeyboard: vi.fn(),
  listeners: new Set<(deviceId: string, sessionId: string) => void>(),
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: state.dismissKeyboard },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({
  back: state.back, canGoBack: () => state.canGoBack, replace: state.replace,
}) }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused }));
vi.mock('../session/remoteSessionStore', () => ({
  remoteSessionStore: {
    onSessionRemoved: (listener: (deviceId: string, sessionId: string) => void) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
  },
}));

// Unit, black-box regression 2026-10-20: a deleted follow-up kept its editor.
// Picker/count tests do not mount this route boundary. Minimal input: an own
// removal signal, with the route focused or hidden. Full pages must unmount the
// editor and return without waiting for the retired sheet's onClosed callback.
describe('side chat task lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = (enabled = true) => act(() => root.render(
    <SideChatTaskBoundary deviceId="host" sessionId="child" enabled={enabled}>
      <textarea aria-label="Message" />
    </SideChatTaskBoundary>,
  ));
  const remove = (deviceId = 'host', sessionId = 'child') => act(() => {
    state.listeners.forEach(listener => listener(deviceId, sessionId));
  });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.focused = true;
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

  it('unmounts only its own deleted task and returns immediately once', () => {
    render();
    remove('other-host');
    remove('host', 'other-child');
    expect(host.querySelector('textarea')).not.toBeNull();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.dismissKeyboard).toHaveBeenCalled();
    expect(state.back).toHaveBeenCalledTimes(1);
    // Removal also clears task metadata; losing source must not revive content.
    render(false);
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('does not pop a different screen when the removed route is unfocused', () => {
    render();
    state.focused = false;
    render();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    state.focused = true;
    render();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary task removal handling unchanged', () => {
    render(false);
    remove();
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(state.back).not.toHaveBeenCalled();
  });

  it('returns to Home when the removed task has no navigation history', () => {
    state.canGoBack = false;
    render();
    remove();
    expect(state.back).not.toHaveBeenCalled();
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/');
  });
});

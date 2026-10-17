// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeableProjectHeader } from '@/session/SwipeableProjectHeader';
import { createSwipeRowRegistry } from '@/session/swipeRowRegistry';

const native = vi.hoisted(() => ({
  props: null as any, offset: { value: 0 }, close: vi.fn(), reset: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  return {
    View: ({ children }: { children?: ReactNode }) => el('div', null, children),
    Pressable: ({ children, accessibilityLabel, onPress }: any) =>
      el('button', { 'aria-label': accessibilityLabel, onClick: onPress }, children),
    StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 400 }),
  };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return { default: { View }, useAnimatedStyle: (factory: () => unknown) => factory(),
    interpolate: () => 1 };
});
vi.mock('@/platform/gestureHandler', async () => {
  const { createElement: el, Fragment, forwardRef, useImperativeHandle } = await import('react');
  return {
    SwipeDirection: { RIGHT: 'right', LEFT: 'left' },
    ReanimatedSwipeable: forwardRef((props: any, ref) => {
      native.props = props;
      useImperativeHandle(ref, () => ({ close: native.close, reset: native.reset }));
      return el(Fragment, null, props.renderLeftActions({}, native.offset),
        props.renderRightActions({}, native.offset), props.children);
    }),
  };
});
vi.mock('lucide-react-native', () => ({ List: () => null, Search: () => null, SquarePen: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/theme', () => ({
  iconSize: { xl: 24 }, iconStroke: { regular: 2 },
  useTheme: () => ({ colors: {} }), useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let registry: ReturnType<typeof createSwipeRowRegistry>;
let destination: string;
function render(projectKey = 'project-a') {
  act(() => root.render(createElement(SwipeableProjectHeader, {
    projectKey, registry,
    onNewTask: () => { destination = 'new'; },
    onOpenTasks: () => { destination = 'tasks'; },
    onSearch: () => { destination = 'search'; },
    children: 'Project',
  })));
}
beforeEach(() => {
  vi.clearAllMocks(); native.offset.value = 0;
  registry = createSwipeRowRegistry(); destination = 'home';
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// Unit: production project header at the native gesture boundary. Existing
// session-row tests cover archive/pin and classic Animated, not these navigation
// actions. Minimal failures: pull past the threshold then retract, or reuse an
// opened project row while a task row owns the same page registry.
describe('project header navigation and swipe lifecycle', () => {
  it.each([
    ['right', 260, 'new'],
    ['right', 100, 'home'],
    ['left', -260, 'home'],
  ])('only opens new-task on a released full right swipe (%s, %s)', (direction, end, target) => {
    render();
    act(() => native.props.onSwipeableOpenStartDrag());
    native.offset.value = 280;
    expect(destination).toBe('home');
    native.offset.value = Number(end);
    act(() => native.props.onSwipeableWillOpen(direction));
    expect(destination).toBe(target);
    if (target === 'new') {
      expect(native.close).toHaveBeenCalledOnce();
      expect(registry.closeOpenRow()).toBe(false);
    }
  });

  it.each([['newTask', 'new'], ['allTasks', 'tasks'], ['search', 'search']])(
    'closes the revealed header before opening %s', (action, target) => {
      render();
      act(() => native.props.onSwipeableOpenStartDrag());
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="devices.list.projectActions.${action}"]`)!.click());
      expect(destination).toBe(target);
      expect(native.close).toHaveBeenCalledOnce();
      expect(registry.closeOpenRow()).toBe(false);
    },
  );

  it('shares mutual exclusion with task rows and does not clear their newer registration', () => {
    render();
    const closeTask = vi.fn();
    registry.onRowOpen('task-a', closeTask);
    act(() => native.props.onSwipeableOpenStartDrag());
    expect(closeTask).toHaveBeenCalledOnce();
    registry.onRowOpen('task-b', closeTask);
    expect(native.close).toHaveBeenCalledOnce();
    act(() => native.props.onSwipeableClose());
    act(() => root.render(null));
    expect(registry.closeOpenRow()).toBe(true);
    expect(closeTask).toHaveBeenCalledTimes(2);
  });

  it('resets a recycled header and retires its previous open-row registration', () => {
    render();
    act(() => native.props.onSwipeableOpenStartDrag());
    native.reset.mockClear();
    render('project-b');
    expect(native.reset).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
    act(() => native.props.onSwipeableOpenStartDrag());
    expect(registry.closeOpenRow()).toBe(true);
    expect(native.close).toHaveBeenCalledOnce();
  });
});

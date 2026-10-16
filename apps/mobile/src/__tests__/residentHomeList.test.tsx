// @vitest-environment jsdom
import { act, memo, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { homeRowPropsEqual } from '../session/homeRowPropsEqual';
import { ResidentHomeList, ResidentHomeListProvider, visibleResidentHomeSlot } from '../session/ResidentHomeList';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

const state = vi.hoisted(() => ({
  platform: 'ios', spring: vi.fn((target: number) => target), hydrated: true, reduceMotion: true, progress: null as any, slide: null as any, mode: 'tasks', segments: ['devices'], width: 1000, anchorWidth: 1000, mounts: 0, unmounts: 0,
  layoutFails: false, hostWindow: { x: 0, y: 0, w: 1280, h: 800 }, anchorWindow: { x: 0, y: 80, w: 1000, h: 720 },
}));
vi.mock('../session/useHomeMode', () => ({ useHomeMode: () => ({ mode: state.mode, hydrated: state.hydrated }) }));
vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => state.reduceMotion }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({
  width: state.width, height: 800, regularWidth: true, regularHeight: true,
  barEdge: 'right', insets: { top: 0, bottom: 0, left: 0, right: 80 },
  regions: [], reservedRegionsSupported: false,
}) }));
vi.mock('../session/remoteSessionStore', () => ({
  RemoteSessionStoreSubscriptionGate: ({ children, enabled }: any) => <div data-subscriptions={enabled}>{children}</div>,
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: any) => v },
    Platform: { get OS() { return state.platform; } },
    View: React.forwardRef(({ children, onLayout, pointerEvents, ...props }: any, ref) => {
      React.useImperativeHandle(ref, () => ({
        measureLayout: (_: any, onSuccess: any, onFail: any) => {
          if (state.layoutFails) { onFail?.(); return; }
          onSuccess(0, 80, state.anchorWidth, 720);
        },
        // 槽位(pointerEvents="none")与宿主各报自己的窗口盒。
        measureInWindow: (callback: any) => {
          const box = pointerEvents === 'none' ? state.anchorWindow : state.hostWindow;
          callback(box.x, box.y, box.w, box.h);
        },
      }));
      React.useEffect(() => { onLayout?.(); }, [onLayout]);
      return <div data-pointer={pointerEvents}>{children}</div>;
    }),
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return { default: { View: ({ children, pointerEvents, style }: any) => <div data-host data-pointer={pointerEvents} data-frame={JSON.stringify(style)}>{children}</div> },
    useSharedValue: (value: number) => { const ref = useRef({ value }); state.progress = ref.current; return ref.current; },
    useAnimatedStyle: (factory: () => any) => { state.slide = factory; return factory(); },
    cancelAnimation: () => {}, withSpring: (target: number) => state.spring(target),
  };
});
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  state.platform = 'ios'; state.spring.mockClear(); state.hydrated = true; state.reduceMotion = true; state.mode = 'tasks'; state.segments = ['devices']; state.width = 1000; state.anchorWidth = 1000;
  state.mounts = 0; state.unmounts = 0;
  state.layoutFails = false;
  state.hostWindow = { x: 0, y: 0, w: 1280, h: 800 }; state.anchorWindow = { x: 0, y: 80, w: 1000, h: 720 };
});
const ListProbe = memo(function ListProbe({ onSelect }: { onSelect(): void }) {
  const [position, setPosition] = useState(0);
  useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
  return <><button data-scroll onClick={() => setPosition(240)}>scroll</button>
    <button data-select onClick={onSelect}>{position}</button></>;
}, homeRowPropsEqual);
function Scene({ detail, homeSelect, detailSelect, homeFocusedOnDetail = false, homeTop = 80 }: any) {
  return <ResidentHomeListProvider>
    <ResidentHomeList focused={!detail || homeFocusedOnDetail} slot="home" top={homeTop} left={0} right={0}>
      <ListProbe onSelect={homeSelect} />
    </ResidentHomeList>
    {detail ? <ResidentHomeList focused slot="sidebar" top={80} left={0} right={0}>
      <ListProbe onSelect={detailSelect} />
    </ResidentHomeList> : null}
  </ResidentHomeListProvider>;
}
it.each([{ homeSegments: [] }, { homeSegments: ['index'] }, { homeSegments: ['devices'] }])('keeps one visible list through home %j → detail → home, while switching actions', ({ homeSegments }) => {
  state.segments = homeSegments;
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const homeSelect = vi.fn(), detailSelect = vi.fn();
  const render = (detail: boolean) => act(() => root.render(<Scene {...{ detail, homeSelect, detailSelect }} />));
  render(false);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('true');
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  state.segments = ['sessions', '[sessionId]']; state.anchorWidth = 320;
  render(true);
  expect(host.querySelectorAll('[data-select]')).toHaveLength(1);
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  act(() => (host.querySelector('[data-select]') as HTMLButtonElement).click());
  expect(detailSelect).toHaveBeenCalledOnce(); expect(homeSelect).not.toHaveBeenCalled();
  state.segments = homeSegments; state.anchorWidth = 1000;
  render(false);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});
it('maps the current route to the one slot that may own the resident list', () => {
  for (const segments of [[], ['index'], ['devices'], ['devices', 'index']]) {
    expect(visibleResidentHomeSlot(segments)).toBe('home');
  }
  expect(visibleResidentHomeSlot(['sessions', '[sessionId]'])).toBe('sidebar');
  for (const segments of [['settings'], ['sessions', 'new'], ['files', '[sessionId]']]) {
    expect(visibleResidentHomeSlot(segments)).toBeNull();
  }
});
it('keeps the sidebar slot as the owner when a retained full-width home keeps publishing on a task route', () => {
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const homeSelect = vi.fn(), detailSelect = vi.fn();
  const render = (props: any) => act(() => root.render(<Scene homeSelect={homeSelect} detailSelect={detailSelect} {...props} />));
  const frame = () => host.querySelector('[data-host]')?.getAttribute('data-frame') ?? '';
  render({ detail: false });
  expect(frame()).toContain('"width":1000');
  // 安卓上会话页里的整宽首页仍然自称 focused:它不得接管已由侧栏拥有的常驻列表。
  state.segments = ['sessions', '[sessionId]']; state.anchorWidth = 320;
  render({ detail: true, homeFocusedOnDetail: true });
  expect(frame()).toContain('"width":320');
  expect(frame()).not.toContain('"width":1000');
  act(() => (host.querySelector('[data-select]') as HTMLButtonElement).click());
  expect(detailSelect).toHaveBeenCalledOnce(); expect(homeSelect).not.toHaveBeenCalled();
  // 隐藏首页在路由切换后回来的迟到测量(重新布局)同样不能把它拉回来。
  render({ detail: true, homeFocusedOnDetail: true, homeTop: 81 });
  expect(frame()).toContain('"width":320');
  state.segments = ['settings'];
  render({ detail: true, homeFocusedOnDetail: true, homeTop: 82 });
  expect(frame()).toContain('"width":320');
});
it('wires the drawer home as the sidebar slot and the route home as the full-width slot', () => {
  expect(source('src/session/HomeSurface.tsx')).toContain("slot={embedded ? 'sidebar' : 'home'}");
});
it('falls back to window coordinates when a re-hosted slot cannot measure against the provider host', () => {
  // 安卓把抽屉内容挂到根浮层(常驻列表宿主的兄弟位置):measureLayout 找不到共同祖先,
  // 槽位必须仍能用两边窗口坐标的差值发布侧栏帧,否则该路由没人拥有列表。
  state.segments = ['sessions', '[sessionId]'];
  state.layoutFails = true;
  state.hostWindow = { x: 0, y: 0, w: 1280, h: 800 };
  state.anchorWindow = { x: 400, y: 96, w: 320, h: 704 };
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  act(() => root.render(<Scene detail homeSelect={() => {}} detailSelect={() => {}} />));
  const frame = host.querySelector('[data-host]')?.getAttribute('data-frame') ?? '';
  expect(frame).toContain('"left":400');
  expect(frame).toContain('"width":320');
  expect(frame).toContain('"top":96');
});
it('hides the resident list and pauses row subscriptions on other routes without destroying it', () => {
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  render();
  state.segments = ['settings']; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

it.each([{ homeSegments: [] }, { homeSegments: ['index'] }, { homeSegments: ['devices'] }, { homeSegments: ['devices', 'index'] }])('keeps task state but hides the resident list in teammate mode on %j', ({ homeSegments }) => {
  state.segments = homeSegments;
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const render = (detail = false) => act(() => root.render(<Scene detail={detail} homeSelect={() => {}} detailSelect={() => {}} />));
  render();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  state.mode = 'teammates'; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  // An actual task route still owns the upstream persistent sidebar, irrespective of home preference.
  state.segments = ['sessions', '[sessionId]']; render(true);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  state.segments = homeSegments; state.mode = 'tasks'; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

it('slides the wide resident list out with its home pane without remounting or intercepting teammate touches', () => {
  state.reduceMotion = false;
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  render(); state.mode = 'teammates'; render(); state.progress.value = 0.5;
  expect(state.slide()).toEqual({ opacity: 1, transform: [{ translateX: -500 }] });
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  state.progress.value = 1; expect(state.slide().opacity).toBe(0);
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

it('switches Android home modes in place, because each pane draws its own bar', () => {
  state.reduceMotion = false; state.platform = 'android';
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  render(); state.mode = 'teammates'; render();
  expect(state.spring).not.toHaveBeenCalled();
  expect(state.progress.value).toBe(1);
});

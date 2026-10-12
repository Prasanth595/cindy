// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWallpaperContentBounds, useWallpaperContentBounds } from '../useWallpaperContentBounds';

const viewport = { width: 1200, height: 800 };
const rect = (left: number, right: number, top = 0, bottom = 800) => ({ left, right, top, bottom });

describe('remaining wallpaper canvas', () => {
  it('excludes task navigation while preserving the entire chat and tool canvas', () => {
    expect(getWallpaperContentBounds(viewport, [rect(0, 260)])).toEqual({
      left: 260,
      top: 0,
      width: 940,
      height: 800,
    });
  });

  it('returns all available space after sidebars collapse', () => {
    expect(getWallpaperContentBounds(viewport, [rect(0, 0)])).toEqual({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
    });
  });

  it('subtracts peek overlays without counting hidden or unrelated sidebars', () => {
    expect(
      getWallpaperContentBounds(viewport, [
        rect(-260, 0),
        rect(0, 260),
        rect(900, 1200, 900, 1000),
      ]),
    ).toEqual({ left: 260, top: 0, width: 940, height: 800 });
  });

  it('preserves the full canvas in detached tool windows without task navigation', () => {
    expect(getWallpaperContentBounds(viewport, [])).toEqual({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
    });
  });
});

describe('wallpaper canvas lifecycle', () => {
  let onResize: () => void;
  let currentRect = rect(0, 260);
  let main: HTMLElement;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
        constructor(callback: () => void) {
          onResize = callback;
        }
      },
    );
    currentRect = rect(0, 260);
    main = document.createElement('aside');
    main.className = 'wallpaper-navigation-surface';
    main.getBoundingClientRect = () => currentRect as DOMRect;
    document.body.append(main);
  });

  afterEach(() => {
    cleanup();
    main.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(20);
    });
  };
  const width = () =>
    document.documentElement.style.getPropertyValue('--app-wallpaper-content-width');

  it('follows pane resizing and removes all fitted state on disable/unmount', async () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useWallpaperContentBounds(enabled), {
      initialProps: { enabled: true },
    });
    expect(width()).toBe('940px');
    expect(observe).toHaveBeenCalledWith(main);
    currentRect = rect(0, 300);
    act(() => onResize());
    await flush();
    expect(width()).toBe('900px');
    rerender({ enabled: false });
    expect(width()).toBe('');
    expect(document.documentElement.dataset.wallpaperFitContent).toBeUndefined();
    rerender({ enabled: true });
    expect(width()).toBe('900px');
    unmount();
    expect(width()).toBe('');
    expect(disconnect).toHaveBeenCalled();
  });

  it('adapts to late pane mount, remount, and transform-only peek completion', async () => {
    main.remove();
    renderHook(() => useWallpaperContentBounds(true));
    expect(width()).toBe('1200px');
    expect(document.documentElement.dataset.wallpaperFitContent).toBeUndefined();
    document.body.append(main);
    await flush();
    expect(width()).toBe('940px');
    expect(document.documentElement.dataset.wallpaperFitContent).toBe('true');
    const peek = document.createElement('aside');
    peek.className = 'wallpaper-navigation-surface';
    let peekRect = rect(0, 260);
    peek.getBoundingClientRect = () => peekRect as DOMRect;
    document.body.append(peek);
    await flush();
    peekRect = rect(0, 320);
    peek.dispatchEvent(new Event('animationend', { bubbles: true }));
    await flush();
    expect(width()).toBe('880px');
    peek.remove();
    main.remove();
    await flush();
    expect(width()).toBe('1200px');
    expect(document.documentElement.dataset.wallpaperFitContent).toBeUndefined();
    document.body.append(main);
    await flush();
    expect(width()).toBe('940px');
    expect(document.documentElement.dataset.wallpaperFitContent).toBe('true');
  });

  it('restores cover when navigation is fully collapsed, then fits again when reopened', async () => {
    renderHook(() => useWallpaperContentBounds(true));
    expect(document.documentElement.dataset.wallpaperFitContent).toBe('true');
    currentRect = rect(0, 0);
    act(() => onResize());
    await flush();
    expect(document.documentElement.dataset.wallpaperFitContent).toBeUndefined();
    currentRect = rect(0, 260);
    act(() => onResize());
    await flush();
    expect(document.documentElement.dataset.wallpaperFitContent).toBe('true');
    expect(width()).toBe('940px');
  });

  it('does not remeasure layout for streamed message contents', async () => {
    const measure = vi.spyOn(main, 'getBoundingClientRect');
    const message = document.createElement('p');
    main.append(message);
    renderHook(() => useWallpaperContentBounds(true));
    const initialCalls = measure.mock.calls.length;
    message.append('streamed text');
    message.dispatchEvent(new Event('animationstart', { bubbles: true }));
    message.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    await flush();
    expect(measure).toHaveBeenCalledTimes(initialCalls);
  });

  it.each([
    ['animationstart', 'animationend'],
    ['animationstart', 'animationcancel'],
    ['transitionrun', 'transitionend'],
    ['transitionrun', 'transitioncancel'],
  ])('tracks intermediate peek frames from %s until %s, then stops', async (start, end) => {
    const motion = { playState: 'running', pending: false };
    main.getAnimations = vi.fn(() => [motion as Animation]);
    const measure = vi.spyOn(main, 'getBoundingClientRect');
    currentRect = rect(-260, 0);
    renderHook(() => useWallpaperContentBounds(true));
    main.dispatchEvent(new Event(start, { bubbles: true }));
    // No ResizeObserver callbacks or mutations between frames.
    for (const edge of [80, 210, 260, 170, 30]) {
      currentRect = rect(edge - 260, edge);
      await flush();
      expect(width()).toBe(`${1200 - edge}px`);
      expect(document.documentElement.style.getPropertyValue('--app-wallpaper-content-left')).toBe(
        `${edge}px`,
      );
      expect(document.documentElement.dataset.wallpaperFitContent).toBe('true');
    }
    currentRect = rect(-260, 0);
    motion.playState = end.endsWith('cancel') ? 'idle' : 'finished';
    main.dispatchEvent(new Event(end, { bubbles: true }));
    await flush();
    expect(width()).toBe('1200px');
    expect(document.documentElement.dataset.wallpaperFitContent).toBeUndefined();
    const calls = measure.mock.calls.length;
    await flush();
    expect(measure).toHaveBeenCalledTimes(calls);
  });

  it('starts tracking an in-flight animation on enable and cancels the frame on disable', async () => {
    main.getAnimations = vi.fn(() => [{ playState: 'running' } as Animation]);
    const measure = vi.spyOn(main, 'getBoundingClientRect');
    const { rerender } = renderHook(({ enabled }) => useWallpaperContentBounds(enabled), {
      initialProps: { enabled: false },
    });
    rerender({ enabled: true });
    currentRect = rect(-130, 130);
    await flush();
    expect(width()).toBe('1070px');
    rerender({ enabled: false });
    const calls = measure.mock.calls.length;
    await flush();
    expect(width()).toBe('');
    expect(measure).toHaveBeenCalledTimes(calls);
  });

  it('does not shrink the canvas when the right tool pane opens or resizes', async () => {
    renderHook(() => useWallpaperContentBounds(true));
    const right = document.createElement('aside');
    right.className = 'bg-content-area';
    right.dataset.panelDragRoot = 'right-tabs';
    right.getBoundingClientRect = () => rect(800, 1200) as DOMRect;
    document.body.append(right);
    await flush();
    expect(width()).toBe('940px');
    expect(observe).not.toHaveBeenCalledWith(right);
    right.style.width = '500px';
    await flush();
    expect(width()).toBe('940px');
    right.remove();
  });
});

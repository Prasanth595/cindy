// @vitest-environment jsdom
/**
 * Production entry: useSessionBackgroundActivity, observed through active/stopping.
 * Bug: stop A -> switch to active B -> A completes must not hide B or disable its stop.
 * No existing tests cover this hook; main activity tests cannot exercise React navigation.
 * Unit tier, deferred IPC only. Also protects push/seed order and subscription disposal.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionBackgroundActivity } from '../useSessionBackgroundActivity';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function installApi(overrides: Record<string, unknown>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: {
    getSessionBackgroundActivity: vi.fn(async () => ({ active: true })),
    onSessionBackgroundActivityChanged: vi.fn(() => () => {}),
    ...overrides,
  } };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useSessionBackgroundActivity lifecycle', () => {
  it('keeps stop state and completion scoped to the task that started it', async () => {
    const stoppedA = deferred<void>();
    const stoppedB = deferred<void>();
    const stop = vi.fn((sid: string) => sid === 'A' ? stoppedA.promise : stoppedB.promise);
    installApi({ stopSessionBackgroundTasks: stop });
    const { result, rerender } = renderHook(({ sid }) => useSessionBackgroundActivity(sid), {
      initialProps: { sid: 'A' },
    });
    await act(async () => {});
    let pendingA!: Promise<void>;
    act(() => { pendingA = result.current.stopAll(); });
    expect(result.current.stopping).toBe(true);
    rerender({ sid: 'B' });
    expect(result.current.stopping).toBe(false);
    await act(async () => {});
    expect(result.current.active).toBe(true);
    let pendingB!: Promise<void>;
    act(() => { pendingB = result.current.stopAll(); });
    await act(async () => { stoppedA.resolve(); await pendingA; });
    expect(result.current).toMatchObject({ active: true, stopping: true });
    await act(async () => { stoppedB.resolve(); await pendingB; });
    expect(result.current).toMatchObject({ active: false, stopping: false });
  });

  it('keeps a pushed activity update when the initial read finishes later', async () => {
    const seed = deferred<{ active: boolean }>();
    let push!: (payload: { sessionId: string; active: boolean }) => void;
    const unsubscribe = vi.fn();
    installApi({
      getSessionBackgroundActivity: () => seed.promise,
      onSessionBackgroundActivityChanged: (listener: typeof push) => { push = listener; return unsubscribe; },
    });
    const { result, unmount } = renderHook(() => useSessionBackgroundActivity('A'));
    act(() => push({ sessionId: 'other', active: true }));
    expect(result.current.active).toBe(false);
    act(() => push({ sessionId: 'A', active: true }));
    await act(async () => seed.resolve({ active: false }));
    expect(result.current.active).toBe(true);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not overwrite newer activity pushed while a stop is settling', async () => {
    const stopped = deferred<void>();
    let push!: (payload: { sessionId: string; active: boolean }) => void;
    installApi({
      onSessionBackgroundActivityChanged: (listener: typeof push) => { push = listener; return () => {}; },
      stopSessionBackgroundTasks: () => stopped.promise,
    });
    const { result } = renderHook(() => useSessionBackgroundActivity('A'));
    await act(async () => {});
    let pending!: Promise<void>;
    act(() => { pending = result.current.stopAll(); });
    act(() => {
      push({ sessionId: 'A', active: false });
      push({ sessionId: 'A', active: true });
    });
    await act(async () => { stopped.resolve(); await pending; });
    expect(result.current).toMatchObject({ active: true, stopping: false });
  });

  it('preserves activity on a failed stop and permits retry', async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error('close failed')).mockResolvedValueOnce(undefined);
    installApi({ stopSessionBackgroundTasks: stop });
    const { result } = renderHook(() => useSessionBackgroundActivity('A'));
    await act(async () => {});
    await act(async () => result.current.stopAll());
    expect(result.current).toMatchObject({ active: true, stopping: false });
    await act(async () => result.current.stopAll());
    expect(result.current).toMatchObject({ active: false, stopping: false });
  });
});

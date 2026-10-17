import { afterEach, expect, it, vi } from 'vitest';
import { createOpenWithIconLoader } from '../openWithIcons';
afterEach(() => vi.useRealTimers());

it('retains and reuses the real native request after a waiter times out', async () => {
  vi.useFakeTimers();
  let finish!: (icon: string | null) => void;
  const loadIcon = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        finish = resolve;
      }),
  );
  const icon = createOpenWithIconLoader({ platform: 'darwin', loadIcon });
  const first = icon('/Applications/Code.app');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toBeNull();
  const second = icon('/Applications/Code.app');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await second).toBeNull();
  expect(loadIcon).toHaveBeenCalledOnce();
  finish('data:image/png;base64,code');
  await Promise.resolve();
  await Promise.resolve();
  expect(await icon('/Applications/Code.app')).toBe('data:image/png;base64,code');
  expect(loadIcon).toHaveBeenCalledOnce();
});
it('never exceeds four real native requests even if all of them hang', async () => {
  vi.useFakeTimers();
  const loadIcon = vi.fn(() => new Promise<null>(() => {}));
  const icon = createOpenWithIconLoader({ platform: 'darwin', loadIcon });
  const first = Promise.all(
    Array.from({ length: 20 }, (_, i) => icon('/Applications/App' + i + '.app')),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect((await first).every((result) => result === null)).toBe(true);
  const later = icon('/Applications/New.app');
  expect(await later).toBeNull();
  expect(loadIcon).toHaveBeenCalledTimes(4);
});
it('uses Windows case-insensitive identity but preserves distinct macOS paths', async () => {
  const loadIcon = vi.fn(async () => null);
  const win = createOpenWithIconLoader({ platform: 'win32', loadIcon });
  await Promise.all([win('C:\\Apps\\Code.exe'), win('c:\\apps\\code.exe')]);
  expect(loadIcon).toHaveBeenCalledOnce();
  const mac = createOpenWithIconLoader({ platform: 'darwin', loadIcon });
  await mac('/Apps/Code.app');
  await mac('/Apps/code.app');
  expect(loadIcon).toHaveBeenCalledTimes(3);
});
it('bounds the completed cache and clears waiter timers on a completed native request', async () => {
  vi.useFakeTimers();
  const loadIcon = vi.fn(async () => 'icon');
  const icon = createOpenWithIconLoader({ platform: 'darwin', loadIcon });
  for (let i = 0; i < 257; i++) await icon('/Apps/' + i + '.app');
  await icon('/Apps/0.app');
  expect(loadIcon).toHaveBeenCalledTimes(258);
  expect(vi.getTimerCount()).toBe(0);
});
it('isolates synchronous native failures and caches the generic fallback', async () => {
  const loadIcon = vi.fn(() => {
    throw new Error('native unavailable');
  });
  const icon = createOpenWithIconLoader({ platform: 'darwin', loadIcon });
  expect(await icon('/Apps/Broken.app')).toBeNull();
  expect(await icon('/Apps/Broken.app')).toBeNull();
  expect(loadIcon).toHaveBeenCalledOnce();
});

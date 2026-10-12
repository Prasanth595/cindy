// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';
import { themeService } from '@/themes/theme-service';
import { cindyLight } from '@/themes/builtin/cindy-light';
import { cindyDark } from '@/themes/builtin/cindy-dark';
import '@/themes/colors';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let changed: (settings: AppearanceSettings) => void;
let saved: AppearanceSettings;
let setPatch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  themeService.applyTheme(cindyLight);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 100,
  } as DOMRect);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  Element.prototype.releasePointerCapture = vi.fn();
  saved = {
    ...DEFAULT_APPEARANCE_SETTINGS,
    wallpaperId: 'cindy-window',
    wallpaperVisibility: 0.4,
  };
  vi.stubGlobal('electronAPI', {
    appearanceSettings: {
      getSync: () => saved,
      onChanged: (listener: typeof changed) => {
        changed = listener;
        return () => {};
      },
      setPatch: (setPatch = vi.fn(async (patch: Partial<AppearanceSettings>) => {
        saved = { ...saved, ...patch };
        changed(saved);
      })),
    },
  });
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const veil = () => document.documentElement.style.getPropertyValue('--app-wallpaper-veil');
const thumb = () =>
  screen.getByRole('slider', { name: 'settings.appearance.wallpaper.visibilityLabel' });
const track = () => thumb().closest('.cindy-slider')!;
function pointer(target: Element, type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}
const view = (show = true) => (
  <WallpaperSettingsProvider>{show && <WallpaperSection />}</WallpaperSettingsProvider>
);

describe('wallpaper visibility settings', () => {
  it('exposes visibility and blur directly without reading controls', () => {
    render(view());
    expect(thumb().getAttribute('aria-valuenow')).toBe('0.4');
    expect(
      screen.queryByRole('switch', { name: 'settings.appearance.wallpaper.readingAutoLabel' }),
    ).toBeNull();
    expect(screen.queryByText('settings.appearance.wallpaper.readingStrengthLabel')).toBeNull();
    expect(
      screen
        .getByRole('slider', { name: 'settings.appearance.wallpaper.blurLabel' })
        .closest('details'),
    ).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue('--app-wallpaper-reading-strength'),
    ).toBe('');
  });
  it('uses the existing visibility preference through save and reload', async () => {
    saved.wallpaperVisibility = 0.6;
    saved.wallpaperReadingStrength = 0.4;
    saved.wallpaperBlur = 3;
    const first = render(view());
    expect(Number(thumb().getAttribute('aria-valuenow'))).toBe(0.6);
    expect(veil()).toBe('40%');
    expect(document.documentElement.dataset.wallpaperReading).toBeUndefined();
    expect(document.documentElement.dataset.wallpaperReadingBlur).toBeUndefined();
    expect(setPatch).not.toHaveBeenCalled();
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 0.61 }),
    );
    expect(veil()).toBe('39%');
    expect(saved).toMatchObject({
      wallpaperVisibility: 0.61,
      wallpaperReadingStrength: 0.4,
      wallpaperBlur: 3,
    });
    first.unmount();
    render(view());
    expect(veil()).toBe('39%');
    expect(Number(thumb().getAttribute('aria-valuenow'))).toBe(0.61);
    fireEvent.keyDown(thumb(), { key: 'ArrowLeft' });
    await waitFor(() => expect(setPatch).toHaveBeenLastCalledWith({ wallpaperVisibility: 0.6 }));
    expect(veil()).toBe('40%');
    expect(document.documentElement.dataset.wallpaperReading).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-blur')).toBe('3px');
  });
  it('returns to saved visibility after a cancelled adjustment', async () => {
    saved.wallpaperVisibility = 0.6;
    saved.wallpaperReadingStrength = 0.4;
    render(view());
    pointer(track(), 'pointerdown', 80);
    expect(veil()).toBe('20%');
    pointer(track(), 'pointercancel', 80);
    await waitFor(() => expect(veil()).toBe('40%'));
    expect(Number(thumb().getAttribute('aria-valuenow'))).toBe(0.6);
    expect(document.documentElement.dataset.wallpaperReading).toBeUndefined();
    expect(document.documentElement.dataset.wallpaperReadingBlur).toBeUndefined();
    expect(setPatch).not.toHaveBeenCalled();
  });
  it('restores saved visibility and explicit blur when the first save fails', async () => {
    saved.wallpaperVisibility = 0.6;
    saved.wallpaperReadingStrength = 0.4;
    saved.wallpaperBlur = 3;
    setPatch.mockRejectedValueOnce(new Error('save failed'));
    render(view());
    fireEvent.keyDown(thumb(), { key: 'End' });
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 1 }),
    );
    await waitFor(() => expect(veil()).toBe('40%'));
    expect(document.documentElement.dataset.wallpaperReading).toBeUndefined();
    expect(document.documentElement.dataset.wallpaperReadingBlur).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-blur')).toBe('3px');
  });
  it('toggles sidebar exclusion without changing the reading strength or wallpaper', async () => {
    render(view());
    const toggle = screen.getByRole('switch', {
      name: 'settings.appearance.wallpaper.excludeSidebarsLabel',
    });
    const image = document.documentElement.style.getPropertyValue('--app-wallpaper-image');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-describedby')).toBe('wallpaper-exclude-sidebars-hint');
    fireEvent.click(screen.getByText('settings.appearance.wallpaper.excludeSidebarsLabel'));
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperExcludeSidebars: true }),
    );
    expect(document.documentElement.dataset.wallpaperExcludeSidebars).toBe('true');
    expect(veil()).toBe('60%');
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toBe(image);
    act(() => changed({ ...saved, wallpaperExcludeSidebars: false }));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.dataset.wallpaperExcludeSidebars).toBeUndefined();
  });
  it('rolls back sidebar exclusion when saving fails', async () => {
    setPatch.mockRejectedValueOnce(new Error('save failed'));
    render(view());
    const toggle = screen.getByRole('switch', {
      name: 'settings.appearance.wallpaper.excludeSidebarsLabel',
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(setPatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(document.documentElement.dataset.wallpaperExcludeSidebars).toBeUndefined();
    expect(veil()).toBe('60%');
  });
  it('resets a sidebar-only preference even when no wallpaper is selected', async () => {
    saved = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperExcludeSidebars: true };
    render(view());
    const toggle = screen.getByRole('switch', {
      name: 'settings.appearance.wallpaper.excludeSidebarsLabel',
    });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(document.documentElement.dataset.wallpaperExcludeSidebars).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }));
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledWith(
        expect.objectContaining({ wallpaperExcludeSidebars: null }),
      ),
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
  it('previews locally, saves only on release and leaves the wallpaper crop unchanged', async () => {
    render(view());
    const image = document.documentElement.style.getPropertyValue('--app-wallpaper-image');
    pointer(track(), 'pointerdown', 60);
    pointer(track(), 'pointermove', 80);
    expect(veil()).toBe('20%');
    await act(async () => {});
    expect(setPatch).not.toHaveBeenCalled();
    pointer(track(), 'pointerup', 80);
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 0.8 }),
    );
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toBe(image);
    expect(
      document.documentElement.style.getPropertyValue('--app-wallpaper-reading-strength'),
    ).toBe('');
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'unmount'])(
    'discards %s previews and returns to the latest broadcast without saving',
    async (cause) => {
      const { rerender } = render(view());
      pointer(track(), 'pointerdown', 80);
      act(() => changed({ ...saved, wallpaperVisibility: 0.6 }));
      expect(veil()).toBe('20%');
      if (cause === 'unmount') rerender(view(false));
      else if (cause === 'blur') fireEvent(window, new Event('blur'));
      else pointer(track(), cause, 80);
      await waitFor(() => expect(veil()).toBe('40%'));
      expect(setPatch).not.toHaveBeenCalled();
    },
  );
  it('commits keyboard input and accepts other-window updates afterwards', async () => {
    render(view());
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 0.41 }),
    );
    act(() => changed({ ...saved, wallpaperVisibility: 0.7 }));
    expect(veil()).toBe('30%');
  });
  it('rolls back a failed save', async () => {
    setPatch.mockRejectedValueOnce(new Error('save failed'));
    render(view());
    fireEvent.keyDown(thumb(), { key: 'End' });
    await waitFor(() =>
      expect(setPatch).toHaveBeenCalledExactlyOnceWith({ wallpaperVisibility: 1 }),
    );
    await waitFor(() => expect(veil()).toBe('60%'));
  });
  it('removes the override and preview on reset and disables the slider for None', async () => {
    render(view());
    pointer(track(), 'pointerdown', 80);
    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }));
    await waitFor(() => expect(setPatch).toHaveBeenCalledOnce());
    expect(setPatch).toHaveBeenCalledWith(
      expect.objectContaining({ wallpaperReadingStrength: null }),
    );
    expect(veil()).toBe('');
    expect(track().hasAttribute('data-disabled')).toBe(true);
    fireEvent.keyDown(thumb(), { key: 'End' });
    expect(setPatch).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.wallpaperReading).toBeUndefined();
  });
  it('retains the original theme defaults and preserves explicit zero', async () => {
    saved.wallpaperVisibility = undefined;
    render(view());
    expect(veil()).toBe('63%');
    await act(async () => themeService.applyTheme(cindyDark));
    expect(veil()).toBe('73%');
    expect(setPatch).not.toHaveBeenCalled();
    act(() => changed({ ...saved, wallpaperVisibility: 0 }));
    expect(veil()).toBe('100%');
    await act(async () => themeService.applyTheme(cindyLight));
    expect(veil()).toBe('100%');
    expect(setPatch).not.toHaveBeenCalled();
  });
});

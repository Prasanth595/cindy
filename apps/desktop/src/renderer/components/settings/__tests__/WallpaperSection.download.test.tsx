// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/../shared/appearanceSettings';

const state = vi.hoisted(() => ({
  pending: false,
  failed: false,
  progress: 0,
  retry: vi.fn(),
  select: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useWallpaperSettings', () => ({
  useWallpaperSettings: () => ({
    ...DEFAULT_APPEARANCE_SETTINGS,
    wallpaperId: 'cindy-window',
    visibility: 1,
    downloadPending: state.pending,
    downloadFailed: state.failed,
    downloadProgress: state.progress,
    retryDownload: state.retry,
    setWallpaper: state.select,
    setVisibility: vi.fn(),
    setBlur: vi.fn(),
    previewBlur: vi.fn(),
    setMotion: vi.fn(),
    resetWallpaper: vi.fn(),
  }),
}));
beforeEach(() => {
  state.pending = false;
  state.failed = false;
  state.progress = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  state.retry.mockReset();
  state.select.mockReset();
  vi.unstubAllGlobals();
});

describe('wallpaper download feedback', () => {
  it('shows pending work only over the selected thumbnail, then removes it on completion', () => {
    state.pending = true;
    const { rerender } = render(<WallpaperSection />);
    const selected = screen.getByRole('radio', {
      name: 'settings.appearance.wallpaper.options.cindy-window',
    });
    const status = within(selected).getByRole('progressbar');
    expect(screen.getAllByRole('progressbar')).toEqual([status]);
    expect(status.getAttribute('aria-valuenow')).toBe('0');
    expect(selected.getAttribute('aria-busy')).toBe('true');
    // The status remains available to assistive technology without a visible text row.
    const description = within(status).getByText('settings.appearance.wallpaper.downloading');
    expect(description.classList.contains('sr-only')).toBe(true);
    expect(selected.getAttribute('aria-describedby')).toBe(description.id);
    expect(
      within(
        screen.getByRole('radio', {
          name: 'settings.appearance.wallpaper.options.cindy-studio',
        }),
      ).queryByRole('progressbar'),
    ).toBeNull();
    for (const progress of [0.25, 0.75, 1]) {
      state.progress = progress;
      rerender(<WallpaperSection />);
      expect(status.getAttribute('aria-valuenow')).toBe(String(progress * 100));
      const fill = status.querySelector<HTMLElement>('[aria-hidden="true"]')!;
      expect(fill.classList.contains('origin-bottom')).toBe(true);
      expect(fill.style.transform).toBe(`scaleY(${progress})`);
    }
    state.pending = false;
    rerender(<WallpaperSection />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(selected.hasAttribute('aria-busy')).toBe(false);
    expect(selected.hasAttribute('aria-describedby')).toBe(false);
  });

  it('retries from the failed thumbnail while other thumbnails still change the selection', () => {
    state.failed = true;
    const { rerender } = render(<WallpaperSection />);
    const selected = screen.getByRole('radio', {
      name: 'settings.appearance.wallpaper.options.cindy-window',
    });
    expect(within(selected).getByRole('status').textContent).toContain('wallpaper.downloadFailed');
    expect(selected.title).toBe('settings.appearance.wallpaper.retryDownload');
    expect(
      screen.queryByRole('button', { name: 'settings.appearance.wallpaper.retryDownload' }),
    ).toBeNull();
    fireEvent.click(selected);
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.select).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.appearance.wallpaper.options.cindy-studio',
      }),
    );
    expect(state.select).toHaveBeenCalledWith('cindy-studio');
    expect(state.retry).toHaveBeenCalledOnce();

    state.pending = true;
    rerender(<WallpaperSection />);
    expect(selected.hasAttribute('title')).toBe(false);
    expect(selected.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(selected);
    expect(state.retry).toHaveBeenCalledOnce();
    state.pending = false;
    state.failed = false;
    rerender(<WallpaperSection />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

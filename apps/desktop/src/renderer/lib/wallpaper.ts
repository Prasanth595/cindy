import type { WallpaperId } from '@/../shared/appearanceSettings';
import cindyWindow from '@/assets/wallpapers/previews/cindy-window.webp';
import cindyStudio from '@/assets/wallpapers/previews/cindy-studio.webp';
import cindyDream from '@/assets/wallpapers/previews/cindy-dream.webp';

export function isSceneWallpaper(id: WallpaperId): id is Exclude<WallpaperId, 'none' | 'custom'> {
  return id === 'cindy-window' || id === 'cindy-studio' || id === 'cindy-dream';
}

/** Decorative artwork; the application applies a theme-derived readability veil. */
const BUILTIN_WALLPAPER_BACKGROUNDS: Partial<Record<WallpaperId, string>> = {
  'cindy-window': `url("${cindyWindow}")`,
  'cindy-studio': `url("${cindyStudio}")`,
  'cindy-dream': `url("${cindyDream}")`,
};

export function getBuiltinWallpaperBackground(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_BACKGROUNDS[id];
}

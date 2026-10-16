import type { WallpaperId } from '@/../shared/appearanceSettings';
import sceneManifest from '@/../shared/wallpaper-video-manifest.json';
import cindyWindow from '@/assets/wallpapers/previews/cindy-window.webp';
import cindyStudio from '@/assets/wallpapers/previews/cindy-studio.webp';
import cindyDream from '@/assets/wallpapers/previews/cindy-dream.webp';
import cindyWhisper from '@/assets/wallpapers/cindy-whisper.webp';
import cindyNeon from '@/assets/wallpapers/cindy-neon.webp';
import cindyPrism from '@/assets/wallpapers/cindy-prism.webp';
import cindyCrimson from '@/assets/wallpapers/cindy-crimson.webp';
import cindyNightGlance from '@/assets/wallpapers/cindy-night-glance.webp';
import cindyScarletStroll from '@/assets/wallpapers/cindy-scarlet-stroll.webp';
import cloudRoaming from '@/assets/wallpapers/cloud-roaming.webp';
import nightLaunch from '@/assets/wallpapers/night-launch.webp';
import stardustVortex from '@/assets/wallpapers/stardust-vortex.webp';
import silentOrbits from '@/assets/wallpapers/silent-orbits.webp';
import duneDawn from '@/assets/wallpapers/dune-dawn.webp';
import planetDawn from '@/assets/wallpapers/planet-dawn.webp';
import neonValley from '@/assets/wallpapers/neon-valley.webp';
import silentCircuit from '@/assets/wallpapers/silent-circuit.webp';
import indigoFolds from '@/assets/wallpapers/indigo-folds.webp';
import wheatfieldWatch from '@/assets/wallpapers/wheatfield-watch.webp';
import moonSolitude from '@/assets/wallpapers/moon-solitude.webp';
import teacupCat from '@/assets/wallpapers/teacup-cat.webp';
import duneSphere from '@/assets/wallpapers/dune-sphere.webp';
import amberLight from '@/assets/wallpapers/amber-light.webp';
import oceanClouds from '@/assets/wallpapers/ocean-clouds.webp';
import blushLeaves from '@/assets/wallpapers/blush-leaves.webp';
import whiteWilderness from '@/assets/wallpapers/white-wilderness.webp';
import blueGaze from '@/assets/wallpapers/blue-gaze.webp';
import roseQuartz from '@/assets/wallpapers/rose-quartz.webp';
import silverVeins from '@/assets/wallpapers/silver-veins.webp';
import dawnArc from '@/assets/wallpapers/dawn-arc.webp';
import tidalLines from '@/assets/wallpapers/tidal-lines.webp';
import cindyWhisperThumbnail from '@/assets/wallpapers/thumbnails/cindy-whisper.webp';
import cindyNeonThumbnail from '@/assets/wallpapers/thumbnails/cindy-neon.webp';
import cindyPrismThumbnail from '@/assets/wallpapers/thumbnails/cindy-prism.webp';
import cindyCrimsonThumbnail from '@/assets/wallpapers/thumbnails/cindy-crimson.webp';
import cindyNightGlanceThumbnail from '@/assets/wallpapers/thumbnails/cindy-night-glance.webp';
import cindyScarletStrollThumbnail from '@/assets/wallpapers/thumbnails/cindy-scarlet-stroll.webp';
import cloudRoamingThumbnail from '@/assets/wallpapers/thumbnails/cloud-roaming.webp';
import nightLaunchThumbnail from '@/assets/wallpapers/thumbnails/night-launch.webp';
import stardustVortexThumbnail from '@/assets/wallpapers/thumbnails/stardust-vortex.webp';
import silentOrbitsThumbnail from '@/assets/wallpapers/thumbnails/silent-orbits.webp';
import duneDawnThumbnail from '@/assets/wallpapers/thumbnails/dune-dawn.webp';
import planetDawnThumbnail from '@/assets/wallpapers/thumbnails/planet-dawn.webp';
import neonValleyThumbnail from '@/assets/wallpapers/thumbnails/neon-valley.webp';
import silentCircuitThumbnail from '@/assets/wallpapers/thumbnails/silent-circuit.webp';
import indigoFoldsThumbnail from '@/assets/wallpapers/thumbnails/indigo-folds.webp';
import wheatfieldWatchThumbnail from '@/assets/wallpapers/thumbnails/wheatfield-watch.webp';
import moonSolitudeThumbnail from '@/assets/wallpapers/thumbnails/moon-solitude.webp';
import teacupCatThumbnail from '@/assets/wallpapers/thumbnails/teacup-cat.webp';
import duneSphereThumbnail from '@/assets/wallpapers/thumbnails/dune-sphere.webp';
import amberLightThumbnail from '@/assets/wallpapers/thumbnails/amber-light.webp';
import oceanCloudsThumbnail from '@/assets/wallpapers/thumbnails/ocean-clouds.webp';
import blushLeavesThumbnail from '@/assets/wallpapers/thumbnails/blush-leaves.webp';
import whiteWildernessThumbnail from '@/assets/wallpapers/thumbnails/white-wilderness.webp';
import blueGazeThumbnail from '@/assets/wallpapers/thumbnails/blue-gaze.webp';
import roseQuartzThumbnail from '@/assets/wallpapers/thumbnails/rose-quartz.webp';
import silverVeinsThumbnail from '@/assets/wallpapers/thumbnails/silver-veins.webp';
import dawnArcThumbnail from '@/assets/wallpapers/thumbnails/dawn-arc.webp';
import tidalLinesThumbnail from '@/assets/wallpapers/thumbnails/tidal-lines.webp';

/** Only manifest-backed scenes use the main-process downloader; local stills stay offline. */
export function isSceneWallpaper(id: WallpaperId): id is keyof typeof sceneManifest {
  return Object.hasOwn(sceneManifest, id);
}

/** Decorative artwork; the application applies a theme-derived readability veil. */
const BUILTIN_WALLPAPER_BACKGROUNDS: Partial<Record<WallpaperId, string>> = {
  'cindy-window': `url("${cindyWindow}")`,
  'cindy-studio': `url("${cindyStudio}")`,
  'cindy-dream': `url("${cindyDream}")`,
  'cindy-whisper': `url("${cindyWhisper}")`,
  'cindy-neon': `url("${cindyNeon}")`,
  'cindy-prism': `url("${cindyPrism}")`,
  'cindy-crimson': `url("${cindyCrimson}")`,
  'cindy-night-glance': `url("${cindyNightGlance}")`,
  'cindy-scarlet-stroll': `url("${cindyScarletStroll}")`,
  'cloud-roaming': `url("${cloudRoaming}")`,
  'night-launch': `url("${nightLaunch}")`,
  'stardust-vortex': `url("${stardustVortex}")`,
  'silent-orbits': `url("${silentOrbits}")`,
  'dune-dawn': `url("${duneDawn}")`,
  'planet-dawn': `url("${planetDawn}")`,
  'neon-valley': `url("${neonValley}")`,
  'silent-circuit': `url("${silentCircuit}")`,
  'indigo-folds': `url("${indigoFolds}")`,
  'wheatfield-watch': `url("${wheatfieldWatch}")`,
  'moon-solitude': `url("${moonSolitude}")`,
  'teacup-cat': `url("${teacupCat}")`,
  'dune-sphere': `url("${duneSphere}")`,
  'amber-light': `url("${amberLight}")`,
  'ocean-clouds': `url("${oceanClouds}")`,
  'blush-leaves': `url("${blushLeaves}")`,
  'white-wilderness': `url("${whiteWilderness}")`,
  'blue-gaze': `url("${blueGaze}")`,
  'rose-quartz': `url("${roseQuartz}")`,
  'silver-veins': `url("${silverVeins}")`,
  'dawn-arc': `url("${dawnArc}")`,
  'tidal-lines': `url("${tidalLines}")`,
};

export function getBuiltinWallpaperBackground(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_BACKGROUNDS[id];
}

/** Picker previews avoid decoding every full-resolution still at once. */
const BUILTIN_WALLPAPER_THUMBNAILS: Partial<Record<WallpaperId, string>> = {
  'cindy-whisper': `url("${cindyWhisperThumbnail}")`,
  'cindy-neon': `url("${cindyNeonThumbnail}")`,
  'cindy-prism': `url("${cindyPrismThumbnail}")`,
  'cindy-crimson': `url("${cindyCrimsonThumbnail}")`,
  'cindy-night-glance': `url("${cindyNightGlanceThumbnail}")`,
  'cindy-scarlet-stroll': `url("${cindyScarletStrollThumbnail}")`,
  'cloud-roaming': `url("${cloudRoamingThumbnail}")`,
  'night-launch': `url("${nightLaunchThumbnail}")`,
  'stardust-vortex': `url("${stardustVortexThumbnail}")`,
  'silent-orbits': `url("${silentOrbitsThumbnail}")`,
  'dune-dawn': `url("${duneDawnThumbnail}")`,
  'planet-dawn': `url("${planetDawnThumbnail}")`,
  'neon-valley': `url("${neonValleyThumbnail}")`,
  'silent-circuit': `url("${silentCircuitThumbnail}")`,
  'indigo-folds': `url("${indigoFoldsThumbnail}")`,
  'wheatfield-watch': `url("${wheatfieldWatchThumbnail}")`,
  'moon-solitude': `url("${moonSolitudeThumbnail}")`,
  'teacup-cat': `url("${teacupCatThumbnail}")`,
  'dune-sphere': `url("${duneSphereThumbnail}")`,
  'amber-light': `url("${amberLightThumbnail}")`,
  'ocean-clouds': `url("${oceanCloudsThumbnail}")`,
  'blush-leaves': `url("${blushLeavesThumbnail}")`,
  'white-wilderness': `url("${whiteWildernessThumbnail}")`,
  'blue-gaze': `url("${blueGazeThumbnail}")`,
  'rose-quartz': `url("${roseQuartzThumbnail}")`,
  'silver-veins': `url("${silverVeinsThumbnail}")`,
  'dawn-arc': `url("${dawnArcThumbnail}")`,
  'tidal-lines': `url("${tidalLinesThumbnail}")`,
};

export function getBuiltinWallpaperPreview(id: WallpaperId): string | undefined {
  return BUILTIN_WALLPAPER_THUMBNAILS[id] ?? getBuiltinWallpaperBackground(id);
}

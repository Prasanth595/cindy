import { desktopCapturer, screen, systemPreferences, type NativeImage } from 'electron';
import { INPUT_HANDOFF_PICTURE_MAX_BYTES } from '@cindy/device-link';
import type { WindowCapture, WindowCaptureError } from './types.js';

/** Longest side sent to the owner: legible on a phone, small enough for one sealed offer. */
const MAX_SIDE = 1400;
const QUALITIES = [72, 60, 48, 38];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a window (screen points, top-left origin) that is on a display,
 * and where that part sits in the display's photo (pixels).
 */
export function windowCrop(
  frame: number[],
  display: Rect,
  photo: { width: number; height: number },
): { area: number[]; pixels: Rect } | null {
  const [x, y, w, h] = frame;
  const left = Math.max(x, display.x);
  const top = Math.max(y, display.y);
  const right = Math.min(x + w, display.x + display.width);
  const bottom = Math.min(y + h, display.y + display.height);
  if (right - left < 8 || bottom - top < 8) return null;
  const sx = photo.width / display.width;
  const sy = photo.height / display.height;
  const px = Math.max(0, Math.round((left - display.x) * sx));
  const py = Math.max(0, Math.round((top - display.y) * sy));
  return {
    area: [left, top, right - left, bottom - top],
    pixels: {
      x: px,
      y: py,
      width: Math.min(photo.width - px, Math.round((right - left) * sx)),
      height: Math.min(photo.height - py, Math.round((bottom - top) * sy)),
    },
  };
}

/** Largest JPEG that fits the offer budget, shrinking the picture only when quality alone is not enough. */
export function fitJpeg(image: NativeImage): { jpeg: Buffer; width: number; height: number } | null {
  let current = image;
  const size = current.getSize();
  if (Math.max(size.width, size.height) > MAX_SIDE) {
    current = size.width >= size.height
      ? current.resize({ width: MAX_SIDE, quality: 'good' })
      : current.resize({ height: MAX_SIDE, quality: 'good' });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const quality of QUALITIES) {
      const jpeg = current.toJPEG(quality);
      if (jpeg.length <= INPUT_HANDOFF_PICTURE_MAX_BYTES) {
        const { width, height } = current.getSize();
        return { jpeg, width, height };
      }
      jpeg.fill(0);
    }
    const { width } = current.getSize();
    current = current.resize({ width: Math.max(320, Math.round(width * 0.7)), quality: 'good' });
  }
  return null;
}

/**
 * Photographs one window from its display, in memory. The full-display photo
 * is cropped immediately and dropped; nothing is written to disk.
 */
export async function captureWindowArea(
  frame: number[],
): Promise<WindowCapture | { error: WindowCaptureError }> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted')
    return { error: 'permission' };
  const [x, y, w, h] = frame;
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const scale = Math.min(display.scaleFactor || 1, 2);
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.bounds.width * scale),
        height: Math.round(display.bounds.height * scale),
      },
      fetchWindowIcons: false,
    });
  } catch {
    return { error: 'unavailable' };
  }
  const photo = sources.find((source) => source.display_id === String(display.id))?.thumbnail;
  if (!photo || photo.isEmpty()) return { error: 'unavailable' };
  const crop = windowCrop(frame, display.bounds, photo.getSize());
  if (!crop) return { error: 'unavailable' };
  const fitted = fitJpeg(photo.crop(crop.pixels));
  if (!fitted) return { error: 'unavailable' };
  return { ...fitted, area: crop.area, windowFrame: [...frame] };
}

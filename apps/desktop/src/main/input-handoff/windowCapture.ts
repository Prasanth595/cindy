import { desktopCapturer, screen, systemPreferences, type NativeImage } from 'electron';
import { INPUT_HANDOFF_PICTURE_MAX_BYTES } from '@cindy/device-link';
import type { FoundQr, WindowCapture, WindowCaptureError } from './types.js';

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
async function photographWindow(
  frame: number[],
): Promise<{ image: NativeImage; area: number[] } | { error: WindowCaptureError }> {
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
  return { image: photo.crop(crop.pixels), area: crop.area };
}

export async function captureWindowArea(
  frame: number[],
): Promise<WindowCapture | { error: WindowCaptureError }> {
  const shot = await photographWindow(frame);
  if ('error' in shot) return shot;
  const fitted = fitJpeg(shot.image);
  if (!fitted) return { error: 'unavailable' };
  return { ...fitted, area: shot.area, windowFrame: [...frame] };
}

/** A QR code found in a picture: its content and place, as fractions (x, y, w, h) with a top-left origin. */
export interface DetectedQr {
  text: string;
  box: number[];
}

/** Longest side of the code sent to the owner: crisp enough to scan from another screen or a saved photo. */
const QR_MAX_SIDE = 720;

/**
 * Where to cut the code out of the window: its box plus a quiet zone around
 * it (scanners need one), in picture pixels, kept inside the picture.
 */
export function qrCrop(box: number[], size: { width: number; height: number }): Rect | null {
  const [bx, by, bw, bh] = box;
  if (![bx, by, bw, bh].every((n) => Number.isFinite(n)) || bw <= 0 || bh <= 0) return null;
  const margin = Math.max(bw * size.width, bh * size.height) * 0.12;
  const left = Math.max(0, Math.floor(bx * size.width - margin));
  const top = Math.max(0, Math.floor(by * size.height - margin));
  const right = Math.min(size.width, Math.ceil((bx + bw) * size.width + margin));
  const bottom = Math.min(size.height, Math.ceil((by + bh) * size.height + margin));
  if (right - left < 16 || bottom - top < 16) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The code the owner should scan: the largest one in the window. */
export function pickQr(codes: DetectedQr[]): DetectedQr | null {
  let best: DetectedQr | null = null;
  for (const code of codes) {
    if (!best || code.box[2] * code.box[3] > best.box[2] * best.box[3]) best = code;
  }
  return best;
}

/**
 * Looks for a QR code in one window (scan-to-sign-in). Returns the code cut
 * out of the window with its content, null when there is none. The window
 * photo stays in memory; `detect` reads it from a pipe.
 */
export async function captureWindowQr(
  frame: number[],
  detect: (jpeg: Buffer) => Promise<DetectedQr[] | null>,
): Promise<FoundQr | null | { error: WindowCaptureError }> {
  const shot = await photographWindow(frame);
  if ('error' in shot) return shot;
  const scan = shot.image.toJPEG(90);
  let codes: DetectedQr[] | null;
  try {
    codes = await detect(scan);
  } finally {
    scan.fill(0);
  }
  // The detector could not look: say so, so a waiting code is not taken as scanned.
  if (!codes) return { error: 'unavailable' };
  const code = pickQr(codes);
  if (!code) return null;
  const size = shot.image.getSize();
  const cut = qrCrop(code.box, size);
  if (!cut) return null;
  let image = shot.image.crop(cut);
  if (Math.max(cut.width, cut.height) > QR_MAX_SIDE) image = image.resize({ width: QR_MAX_SIDE, quality: 'good' });
  const fitted = fitJpeg(image);
  if (!fitted) return null;
  const [x, y, w, h] = shot.area;
  return {
    text: code.text,
    capture: {
      ...fitted,
      // Taps on the code (for example "tap to refresh" on an expired one) land on the code in the window.
      area: [x + (cut.x / size.width) * w, y + (cut.y / size.height) * h, (cut.width / size.width) * w, (cut.height / size.height) * h],
      windowFrame: [...frame],
    },
  };
}

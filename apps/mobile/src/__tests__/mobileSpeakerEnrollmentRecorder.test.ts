import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), start: vi.fn() }));
const app = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(state: string) => void>(),
  addEventListener: (_event: string, listener: (state: string) => void) => {
    app.listeners.add(listener);
    return { remove: () => app.listeners.delete(listener) };
  },
}));
vi.mock('expo-audio', () => ({
  getRecordingPermissionsAsync: audio.get,
  requestRecordingPermissionsAsync: audio.request,
}));
vi.mock('react-native', () => ({ AppState: app }));
vi.mock('@/session/mobileRealtimeAudio', () => ({ startMobileRealtimeAudio: audio.start }));

import {
  MobileSpeakerEnrollmentAbortedError,
  MobileSpeakerEnrollmentNoAudioError,
  recordMobileSpeakerClip,
} from '@/session/mobileSpeakerEnrollmentRecorder';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function appState(state: string) {
  app.currentState = state;
  for (const listener of app.listeners) listener(state);
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function emit(samples = 1600) {
  audio.start.mock.calls[0][0].onChunk({ pcm16: new Int16Array(samples).buffer });
}

describe('speaker enrollment microphone lifecycle', () => {
  const stop = vi.fn(async () => {});
  beforeEach(() => {
    vi.clearAllMocks();
    app.currentState = 'active';
    app.listeners.clear();
    audio.get.mockResolvedValue({ granted: true });
    audio.request.mockResolvedValue({ granted: true });
    audio.start.mockResolvedValue(stop);
  });
  afterEach(() => {
    expect(app.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('requests first-use permission and waits for foreground before opening the microphone', async () => {
    const permission = deferred<{ granted: boolean }>();
    audio.get.mockResolvedValue({ granted: false });
    audio.request.mockImplementation(() => { appState('background'); return permission.promise; });
    const recording = recordMobileSpeakerClip({ durationMs: 100 });
    await flush();
    expect(audio.request).toHaveBeenCalledOnce();
    expect(audio.start).not.toHaveBeenCalled();
    permission.resolve({ granted: true });
    await flush();
    expect(audio.start).not.toHaveBeenCalled();
    appState('active');
    await flush();
    emit();
    expect((await recording).byteLength).toBe(3200);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not start capture when permission is denied', async () => {
    audio.get.mockResolvedValue({ granted: false });
    audio.request.mockResolvedValue({ granted: false });
    await expect(recordMobileSpeakerClip({ durationMs: 100 })).rejects.toThrow('microphone permission denied');
    expect(audio.start).not.toHaveBeenCalled();
  });

  it('does not start after cancellation while the permission dialog is open', async () => {
    const permission = deferred<{ granted: boolean }>();
    audio.get.mockResolvedValue({ granted: false });
    audio.request.mockReturnValue(permission.promise);
    const controller = new AbortController();
    const recording = recordMobileSpeakerClip({ durationMs: 100, signal: controller.signal });
    const rejected = expect(recording).rejects.toBeInstanceOf(MobileSpeakerEnrollmentAbortedError);
    await flush();
    controller.abort();
    permission.resolve({ granted: true });
    await rejected;
    expect(audio.start).not.toHaveBeenCalled();
  });

  it('stops capture and discards late chunks when backgrounded', async () => {
    const progress = vi.fn();
    const recording = recordMobileSpeakerClip({ durationMs: 100, onProgress: progress });
    const rejected = expect(recording).rejects.toBeInstanceOf(MobileSpeakerEnrollmentAbortedError);
    await flush();
    appState('background');
    emit();
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalled();
  });

  it('releases a microphone whose startup finishes after cancellation', async () => {
    const startup = deferred<() => Promise<void>>();
    audio.start.mockReturnValue(startup.promise);
    const controller = new AbortController();
    const recording = recordMobileSpeakerClip({ durationMs: 100, signal: controller.signal });
    const rejected = expect(recording).rejects.toBeInstanceOf(MobileSpeakerEnrollmentAbortedError);
    await flush();
    controller.abort();
    startup.resolve(stop);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });

  it('fails a stalled microphone and releases it', async () => {
    vi.useFakeTimers();
    const recording = recordMobileSpeakerClip({ durationMs: 100 });
    const rejected = expect(recording).rejects.toBeInstanceOf(MobileSpeakerEnrollmentNoAudioError);
    await flush();
    await vi.advanceTimersByTimeAsync(5100);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not request permission or start capture for an already cancelled recording', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(recordMobileSpeakerClip({ durationMs: 100, signal: controller.signal }))
      .rejects.toBeInstanceOf(MobileSpeakerEnrollmentAbortedError);
    expect(audio.get).not.toHaveBeenCalled();
    expect(audio.start).not.toHaveBeenCalled();
  });
});

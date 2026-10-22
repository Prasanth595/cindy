import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: { isSupported: vi.fn(() => true), hasPermission: vi.fn(async () => true),
    requestPermission: vi.fn(async () => true), install: vi.fn(async (_file: string, _version: string) => undefined) },
  state: { currentState: 'active' },
  appStateListener: undefined as ((state: string) => void) | undefined,
  onProgress: undefined as ((data: { bytesWritten: number; totalBytes: number }) => void) | undefined,
  file: '', resumeData: undefined as string | undefined,
  files: new Map<string, number>(),
  download: vi.fn<() => Promise<object | null>>(),
  resolveDownload: undefined as ((value: object | null) => void) | undefined,
  rejectDownload: undefined as ((error: Error) => void) | undefined,
  cancel: vi.fn(), release: vi.fn(), unsubscribe: vi.fn(), browser: vi.fn(async () => undefined),
  remove: vi.fn(async (file: string) => { mocks.files.delete(file); }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { get currentState() { return mocks.state.currentState; },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      mocks.appStateListener = callback; return { remove: mocks.unsubscribe };
    } },
  Linking: { openURL: mocks.browser },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => []),
  getInfoAsync: vi.fn(async (file: string) => mocks.files.has(file)
    ? { exists: true, isDirectory: false, size: mocks.files.get(file), modificationTime: Date.now() / 1000 }
    : { exists: false }),
  deleteAsync: mocks.remove,
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    mocks.files.set(to, mocks.files.get(from) ?? 0); mocks.files.delete(from);
  }),
}));
vi.mock('expo-file-system', () => ({
  File: class { constructor(public uri: string) {} },
  DownloadTask: class {
    constructor(_url: string, file: { uri: string }, options: { onProgress: typeof mocks.onProgress }) {
      mocks.file = file.uri; mocks.onProgress = options.onProgress; mocks.resumeData = undefined;
    }
    static fromSavable(saved: { url: string; fileUri: string; resumeData: string }, options: { onProgress: typeof mocks.onProgress }) {
      const task = new this(saved.url, { uri: saved.fileUri }, options);
      mocks.resumeData = saved.resumeData; return task;
    }
    downloadAsync = mocks.download;
    resumeAsync = mocks.download;
    state = 'active';
    pauseAsync = mocks.cancel;
    release = mocks.release;
  },
}));
import { androidInstaller } from './androidInstaller';
const target = { installUrl: 'https://updates.example.invalid/app.apk', version: '1.2.3' };
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const pending = () => mocks.download.mockImplementation(() => new Promise((resolve, reject) => { mocks.resolveDownload = resolve; mocks.rejectDownload = reject; }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.files.clear();
  mocks.state.currentState = 'active'; mocks.rejectDownload = undefined; mocks.resolveDownload = undefined;
  mocks.download.mockResolvedValue({});
  mocks.cancel.mockImplementation(async () => mocks.resolveDownload?.(null));
});
afterEach(async () => { androidInstaller.close(); await settle(); vi.useRealTimers(); });

// Unit regression: the public installer previously deleted partial APKs on failure.
// Seed on-disk bytes (including a previous process's file) and observe the resume
// offset and installation through start/retry, not just storage helper calls.
describe('Android installer IO', () => {
  it('retains the downloaded APK for the system installer', async () => {
    androidInstaller.start(target); await settle();
    expect(mocks.file).toMatch(/^file:\/\/\/cache\/cindy-updates\/update-resume-[a-f0-9]{64}\.apk$/);
    expect(mocks.native.install).toHaveBeenCalledWith(expect.stringMatching(/\/update-[0-9]+-[a-z0-9]+\.apk$/), target.version);
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    mocks.onProgress!({ bytesWritten: 100, totalBytes: 100 });
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overwrites a completed file held by the system installer', async () => {
    androidInstaller.start(target); await settle();
    const handedOff = mocks.native.install.mock.calls[0][0];
    expect(mocks.files.has(handedOff)).toBe(true);
    androidInstaller.close(); await settle();
    androidInstaller.start(target); await settle();
    expect(mocks.resumeData).toBeUndefined();
    expect(mocks.files.has(handedOff)).toBe(true);
    expect(mocks.native.install.mock.calls[1][0]).not.toBe(handedOff);
  });

  it('retains interrupted bytes and resumes from disk on retry', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 256);
    mocks.rejectDownload!(new Error('connection lost')); await settle();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.download.mockResolvedValue({}); androidInstaller.retry(); await settle();
    expect(mocks.resumeData).toBe('256');
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('cancels stalled transfers but keeps their bytes available for retry', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 128);
    await vi.advanceTimersByTimeAsync(90_000); await settle();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
    await androidInstaller.browser();
    expect(mocks.browser).toHaveBeenCalledWith(target.installUrl);
  });

  it('reopens with persisted bytes and never shares them with another release', async () => {
    pending(); androidInstaller.start(target); await settle();
    const original = mocks.file; mocks.files.set(original, 512);
    androidInstaller.close(); await settle();
    mocks.download.mockResolvedValue({}); androidInstaller.start(target); await settle();
    expect(mocks.file).toBe(original); expect(mocks.resumeData).toBe('512');
    androidInstaller.close(); await settle();
    androidInstaller.start({ ...target, version: '1.2.4' }); await settle();
    expect(mocks.file).not.toBe(original); expect(mocks.resumeData).toBeUndefined();
  });

  it('waits for a cancelled native writer before immediately reopening', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.cancel.mockImplementation(async () => undefined);
    androidInstaller.close(); androidInstaller.start(target); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    mocks.files.set(mocks.file, 333);
    mocks.download.mockResolvedValue({}); mocks.rejectDownload!(new Error('cancelled')); await settle();
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.resumeData).toBe('333');
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('retries an unsatisfiable range from zero once', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 99); androidInstaller.close(); await settle();
    mocks.download.mockRejectedValueOnce(new Error('HTTP 416')).mockResolvedValueOnce({});
    androidInstaller.start(target); await settle();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(mocks.resumeData).toBeUndefined();
    expect(androidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('HTTP failures never launch installation or discard the previous partial', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.files.set(mocks.file, 256);
    mocks.rejectDownload!(new Error('connection lost')); await settle();
    mocks.download.mockRejectedValue(new Error('HTTP 503'));
    androidInstaller.retry(); await settle();
    expect(mocks.files.get(mocks.file)).toBe(256);
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('error');
  });

  it('reports unknown length without fake percentages and refreshes the stall timer', async () => {
    pending(); androidInstaller.start(target); await settle();
    mocks.onProgress!({ bytesWritten: 20, totalBytes: -1 });
    expect(androidInstaller.getSnapshot().progress).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    mocks.onProgress!({ bytesWritten: 50, totalBytes: 100 });
    expect(androidInstaller.getSnapshot().progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(androidInstaller.getSnapshot().phase).toBe('downloading');
    androidInstaller.close(); await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('waits for the foreground before opening installation', async () => {
    mocks.state.currentState = 'background'; androidInstaller.start(target); await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    mocks.state.currentState = 'active'; mocks.appStateListener!('active'); await settle();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancelling a background handoff prevents later installation', async () => {
    mocks.state.currentState = 'background'; androidInstaller.start(target); await settle();
    androidInstaller.close(); await settle();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(androidInstaller.getSnapshot().phase).toBe('idle');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadRemoteMediaAsDataUri,
  downloadRemoteMediaShareTemp,
  withDownloadedRemoteMediaFile,
} from '@/session/remoteMediaDiskCacheExpo';

const io = vi.hoisted(() => ({
  size: 5,
  copying: new Set<string>(),
  copied: new Set<string>(),
  download: vi.fn(),
  remove: vi.fn(),
  resumable: vi.fn(),
  cancel: vi.fn(async () => undefined),
  deleteAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: (url: string, uri: string) => ({
    downloadAsync: () => io.resumable(url, uri),
    cancelAsync: io.cancel,
  }),
  deleteAsync: io.deleteAsync,
}));

vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///app/cache' },
  Directory: class {
    uri: string;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = typeof parent === 'string' ? parent : `${parent.uri}/${name}`;
    }
    // expo-file-system's File.copy is asynchronous; the destination is empty until it settles.
    async copy(target: { uri: string }) {
      io.copying.add(target.uri);
      await new Promise((done) => setTimeout(done, 0));
      io.copying.delete(target.uri);
      io.copied.add(target.uri);
    }
    get size() { return io.copying.has(this.uri) ? 0 : io.size; }
    get exists() { return true; }
    async base64() { return 'aGVsbG8='; }
    delete() { io.remove(this.uri); }
    static downloadFileAsync = io.download;
  },
}));

beforeEach(() => {
  io.size = 5;
  io.copying.clear();
  io.copied.clear();
  io.remove.mockClear();
  io.download.mockReset().mockImplementation(async (_url, target) => target);
  io.resumable.mockReset().mockResolvedValue({ status: 200 });
  io.cancel.mockClear();
  io.deleteAsync.mockClear();
});

describe('bounded temporary media downloads', () => {
  it('keeps the file until the asynchronous consumer finishes, then removes it', async () => {
    let finish!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>((done) => { finish = done; }));
    const result = withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(io.remove).not.toHaveBeenCalled();
    finish('dimensions and embedded bytes');
    expect(await result).toBe('dimensions and embedded bytes');
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(io.download.mock.calls[0]![1].uri);
  });

  it.each([0, 9])('removes a %s-byte download without exposing it to the consumer', async (size) => {
    io.size = size;
    const read = vi.fn();
    expect(await withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledOnce();
  });

  it.each(['download', 'read'])('removes partial files after a %s failure', async (failure) => {
    const read = vi.fn(async () => { throw new Error('read failed'); });
    if (failure === 'download') io.download.mockRejectedValueOnce(new Error('interrupted'));
    expect(await withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read)).toBeNull();
    expect(io.remove).toHaveBeenCalledOnce();
  });

  it('waits for a direct-transfer copy before sizing or reading the file', async () => {
    const read = vi.fn(async (file: { uri: string }) => (io.copied.has(file.uri) ? 'copied' : 'missing'));
    expect(await withDownloadedRemoteMediaFile('file:///peer/staged', 'image/png', 8, read)).toBe('copied');
    expect(read).toHaveBeenCalledOnce();
    expect(io.download).not.toHaveBeenCalled();
  });

  it('preserves the existing inline-resource download contract', async () => {
    expect(await downloadRemoteMediaAsDataUri('https://example.com/image', 'image/png', 8))
      .toBe('data:image/png;base64,aGVsbG8=');
    expect(io.remove).toHaveBeenCalledOnce();
  });
});

describe('share temp downloads', () => {
  it('keeps the existing download path when no cancellation signal is given', async () => {
    expect(await downloadRemoteMediaShareTemp('https://example.com/a.pdf', 'application/pdf', 'a.pdf'))
      .toMatch(/\/a\.pdf$/);
    expect(io.download).toHaveBeenCalledOnce();
    expect(io.resumable).not.toHaveBeenCalled();
  });

  it('downloads through a cancellable task when a signal is given', async () => {
    const uri = await downloadRemoteMediaShareTemp(
      'https://example.com/a.pdf', 'application/pdf', 'a.pdf', new AbortController().signal,
    );
    expect(uri).toMatch(/\/a\.pdf$/);
    expect(io.resumable).toHaveBeenCalledExactlyOnceWith('https://example.com/a.pdf', uri);
    expect(io.download).not.toHaveBeenCalled();
  });

  it('stops the transfer and removes the partial file on cancel', async () => {
    io.resumable.mockReturnValue(new Promise(() => {})); // native download never settles after cancel
    const abort = new AbortController();
    const result = downloadRemoteMediaShareTemp('https://example.com/a.pdf', 'application/pdf', 'a.pdf', abort.signal);
    await vi.waitFor(() => expect(io.resumable).toHaveBeenCalledOnce());
    abort.abort();
    expect(await result).toBeNull();
    expect(io.cancel).toHaveBeenCalled();
    expect(io.deleteAsync).toHaveBeenCalledExactlyOnceWith(io.resumable.mock.calls[0]![1], { idempotent: true });
    // The partial file is removed only after the native task has confirmed it stopped.
    expect(io.cancel.mock.invocationCallOrder.at(-1)!).toBeLessThan(io.deleteAsync.mock.invocationCallOrder[0]!);
  });

  it('removes a direct-transfer copy that finished after cancel', async () => {
    const abort = new AbortController();
    const result = downloadRemoteMediaShareTemp('file:///peer/staged', 'application/pdf', 'a.pdf', abort.signal);
    abort.abort(); // local File.copy cannot be interrupted; the copy settles afterwards
    expect(await result).toBeNull();
    expect(io.copied.size).toBe(1);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith([...io.copied][0]);
  });

  it('treats a non-2xx response as a failed download', async () => {
    io.resumable.mockResolvedValue({ status: 403 });
    expect(await downloadRemoteMediaShareTemp(
      'https://example.com/a.pdf', 'application/pdf', 'a.pdf', new AbortController().signal,
    )).toBeNull();
    expect(io.deleteAsync).toHaveBeenCalledOnce();
  });
});

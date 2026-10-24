/**
 * audioFileProtocolRange.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the Range header parser AND the handler-level static validation
 * (URL host / path absoluteness / extension whitelist / fs.stat error mapping)
 * for the xdt-audio:// protocol.
 *
 * The Range parser here intentionally diverges from videoProtocol's: it must
 * tell `unsatisfiable` (→ 416) apart from `absent / malformed` (→ 200) so the
 * handler can dispatch correctly. videoProtocol returned `null` for both,
 * which would silently collapse the 416 branch.
 */

import * as path from 'node:path';
import nativeFs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import { Readable } from 'node:stream';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(async (p: string) => p),
}));

// 黑名单判定 mock 成可控开关:本文件只测 handler 的接线(blocked→403 / 放行→200 /
// realpath 结果用于读文件);isPathAllowedAgainst 的真实语义由 filePathPolicy.test
// 与 mediaFetch.test 覆盖。真实实现对 Windows 盘符路径在 POSIX 宿主上恒 false,
// 会把下面的 drive-letter 用例误拦。
const pathAllowedMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../filePathPolicy', () => ({
  getSensitiveMediaBlocklist: () => ['/sentinel-blocklist'],
  isPathAllowedAgainst: pathAllowedMock,
}));

const fs = await import('node:fs/promises');
const electron = await import('electron');
const { parseRangeHeader, registerAudioFileProtocolHandler } = await import(
  '../audioFileProtocol'
);

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let content = Buffer.from('0123456789');
function fileStat() {
  return { isFile: () => true, dev: 1n, ino: 1n, size: BigInt(content.byteLength) };
}

beforeEach(() => {
  vi.resetAllMocks();
  content = Buffer.from('0123456789');
  pathAllowedMock.mockReturnValue(true);
  vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
  vi.mocked(fs.stat).mockResolvedValue(fileStat() as Awaited<ReturnType<typeof fs.stat>>);
  vi.mocked(fs.readFile).mockImplementation(async () => content);
  vi.mocked(fs.open).mockImplementation(async () => ({
    stat: async () => fileStat(),
    createReadStream: ({ start, end }: { start: number; end: number }) =>
      Readable.from([content.subarray(start, end + 1)]),
    close: async () => {},
  } as unknown as FileHandle));
});

describe('parseRangeHeader', () => {
  it('returns null when header is absent', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });

  it('parses bytes=0- (chromium <audio> initial fetch) → full file range', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    });
  });

  it('parses an explicit closed range', () => {
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({
      kind: 'range',
      start: 100,
      end: 199,
    });
  });

  it('parses a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-256', 1000)).toEqual({
      kind: 'range',
      start: 744,
      end: 999,
    });
  });

  it('clamps valid ends at EOF and rejects starts outside the file', () => {
    expect(parseRangeHeader('bytes=0-9999', 1000)).toEqual({
      kind: 'range', start: 0, end: 999,
    });
    expect(parseRangeHeader('bytes=500-100', 1000)).toEqual({
      kind: 'unsatisfiable',
    });
    expect(parseRangeHeader('bytes=2000-', 1000)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('returns null for malformed header (caller falls back to 200)', () => {
    expect(parseRangeHeader('blocks=0-100', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
  });

  it('handles whitespace around the value', () => {
    expect(parseRangeHeader('  bytes=0-9  ', 1000)).toEqual({
      kind: 'range',
      start: 0,
      end: 9,
    });
  });
});

// ---------------------------------------------------------------------------
// Handler validation tests.
//
// We capture the handler function passed to protocol.handle() and invoke it
// directly with a synthetic Request. File metadata and the opened handle are
// injected to exercise URL parsing, validation and error mapping.
// ---------------------------------------------------------------------------

function getHandler(): (req: Request) => Promise<Response> {
  const handle = electron.protocol.handle as unknown as ReturnType<typeof vi.fn>;
  registerAudioFileProtocolHandler();
  const lastCall = handle.mock.calls[handle.mock.calls.length - 1];
  return lastCall[1] as (req: Request) => Promise<Response>;
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('audio handler validation', () => {
  it('rejects a realpath target inside the sensitive blocklist with 403 (no read)', async () => {
    pathAllowedMock.mockReturnValue(false);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Fhome%2Fme%2F.ssh%2Fleak.mp3'),
    );
    expect(res.status).toBe(403);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('checks the blocklist against the realpath and reads from it (symlink escape / TOCTOU)', async () => {
    const real = '/home/me/.ssh/actual.mp3';
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(real);
    vi.mocked(fs.stat).mockResolvedValue(fileStat() as Awaited<ReturnType<typeof fs.stat>>);
    content = Buffer.from('X');
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Finnocent.mp3'),
    );
    expect(res.status).toBe(200);
    // both the lexical (requested) form and the realpath are consulted
    expect(pathAllowedMock).toHaveBeenCalledWith(
      path.resolve('/tmp/innocent.mp3'),
      ['/sentinel-blocklist'],
    );
    expect(pathAllowedMock).toHaveBeenCalledWith(real, ['/sentinel-blocklist']);
    expect(fs.stat).toHaveBeenCalledWith(real, { bigint: true });
    expect(fs.open).toHaveBeenCalledWith(real, expect.any(Number));
    expect(await res.text()).toBe('X');
  });

  it('rejects non-local host with 403', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://other/?path=%2Ftmp%2Ffoo.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects missing path query with 400', async () => {
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/'));
    expect(res.status).toBe(400);
  });

  it('rejects relative path with 403', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=relative%2Ffoo.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects non-whitelisted extension with 415', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Fetc%2Fpasswd'),
    );
    expect(res.status).toBe(415);
  });

  it('rejects directory (stat.isFile()===false) with 404', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => false,
    });
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fdir.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('maps ENOENT (file missing) to 404', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fmissing.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('maps realpath ENOTDIR (non-dir path component) to 404, not 500', async () => {
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('not a dir'), { code: 'ENOTDIR' }),
    );
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/?path=%2Ffoo%2Fbar.mp3%2Fx.mp3'));
    expect(res.status).toBe(404);
  });

  it('maps realpath EPERM to 403 (parity with localFileProtocol)', async () => {
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EPERM' }),
    );
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/?path=%2Ftmp%2Flocked.mp3'));
    expect(res.status).toBe(403);
  });

  it('maps ELOOP (symlink loop) to 404', async () => {
    const err = Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Floop.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('accepts uppercase whitelisted extension (case-insensitive)', async () => {
    vi.mocked(fs.stat).mockResolvedValue(fileStat() as Awaited<ReturnType<typeof fs.stat>>);
    content = Buffer.from('FAKE_MP3');
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2FOUT.MP3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('accepts Windows drive-letter absolute paths (WIN_ABS_RE branch)', async () => {
    vi.mocked(fs.stat).mockResolvedValue(fileStat() as Awaited<ReturnType<typeof fs.stat>>);
    content = Buffer.from('FAKE_MP3');
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=C%3A%5CUsers%5Cme%5COUT.mp3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('maps EPERM (Windows permission denial) to 403', async () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Flocked.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it.each([['ENOTDIR', 404], ['EPERM', 403]] as const)(
    'maps %s while opening the checked file to %s', async (code, status) => {
      vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error(code), { code }));
      expect((await getHandler()(makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3'))).status)
        .toBe(status);
    },
  );

  it('rejects an unavailable inode identity and closes the unserved handle', async () => {
    const stat = { ...fileStat(), ino: 0n };
    const close = vi.fn(async () => {});
    vi.mocked(fs.stat).mockResolvedValue(stat as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.open).mockResolvedValue({ stat: async () => stat, close } as unknown as FileHandle);
    expect((await getHandler()(makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3'))).status)
      .toBe(403);
    expect(close).toHaveBeenCalledOnce();
  });

  it('serves filename with a literal % (no double-decode regression)', async () => {
    // URLSearchParams.get already percent-decodes; if the handler
    // ever calls decodeURIComponent again, this filename's residual
    // `% ` becomes an invalid escape and throws URIError → 500.
    vi.mocked(fs.stat).mockResolvedValue(fileStat() as Awaited<ReturnType<typeof fs.stat>>);
    content = Buffer.from('OK');
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2F100%25%20done.mp3'),
    );
    expect(res.status).toBe(200);
  });
});

describe('audio handler range responses', () => {
  // Unit regression for RFC 9110 §14.1.2: the previous fixture incorrectly
  // treated a valid start with an end beyond EOF as unsatisfiable.
  it.each([
    ['bytes=2-5', 'bytes 2-5/10', '2345'],
    ['bytes=2-999', 'bytes 2-9/10', '23456789'],
  ])('serves %s as 206 with exact bytes + headers', async (range, contentRange, body) => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3', {
        headers: { Range: range },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(contentRange);
    expect(res.headers.get('Content-Length')).toBe(String(body.length));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(body);
  });

  it('maps an unsatisfiable range to 416 with full media headers', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3', {
        headers: { Range: 'bytes=999-' },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('falls back to 200 full body when Range header is absent', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });
});

/**
 * Unit regressions through the registered production handler. The old mocks
 * returned tiny Buffers, hiding whole-file reads and missing cancellation.
 * A sparse 16 MiB file with a 1 KiB Range exposes that size-dependent bug;
 * bounded real IO also verifies descriptor ownership.
 */
describe('audio handler file streaming', () => {
  let dir: string;
  let filePath: string;
  let url: string;
  let files: FileHandle[];
  let streams: nativeFs.ReadStream[];

  beforeEach(() => {
    dir = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'audio-range-'));
    filePath = path.join(dir, 'clip.wav');
    nativeFs.writeFileSync(filePath, '0123456789');
    url = `xdt-audio://local/?path=${encodeURIComponent(filePath)}`;
    files = [];
    streams = [];
    vi.mocked(fs.realpath).mockImplementation(actualFs.realpath);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args);
      files.push(file);
      const create = file.createReadStream.bind(file);
      vi.spyOn(file, 'createReadStream').mockImplementation((options) => {
        const stream = create(options);
        streams.push(stream);
        return stream;
      });
      return file;
    });
  });

  afterEach(async () => {
    for (const stream of streams) stream.destroy();
    for (const file of files) await file.close();
    vi.restoreAllMocks();
    nativeFs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads only a 1 KiB range from a large audio file and closes the descriptor', async () => {
    nativeFs.truncateSync(filePath, 16 * 1024 * 1024);
    const response = await getHandler()(new Request(url, { headers: { Range: 'bytes=0-1023' } }));
    expect(response.status).toBe(206);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(1024);
    expect(bytes.subarray(0, 10).toString()).toBe('0123456789');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(streams.map((stream) => stream.bytesRead)).toEqual([1024]);
    await vi.waitFor(() => expect(files[0].fd).toBe(-1));
  });

  it.each(['cancel', 'abort'] as const)('closes an open-ended audio response on %s', async (action) => {
    nativeFs.truncateSync(filePath, 16 * 1024 * 1024);
    const controller = new AbortController();
    const response = await getHandler()(new Request(url, {
      signal: controller.signal, headers: { Range: 'bytes=0-' },
    }));
    if (action === 'cancel') await response.body!.cancel();
    else {
      controller.abort();
      await expect(response.arrayBuffer()).rejects.toThrow();
    }
    expect(fs.readFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(files[0].fd).toBe(-1));
    expect(streams[0].bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
  });

  it('closes an empty file without creating a stream', async () => {
    nativeFs.truncateSync(filePath, 0);
    const response = await getHandler()(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('0');
    expect(await response.text()).toBe('');
    expect(files[0].fd).toBe(-1);
    expect(streams).toHaveLength(0);
  });

  it('rejects a file replaced before open and closes its unserved descriptor', async () => {
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      nativeFs.renameSync(filePath, `${filePath}.old`);
      nativeFs.writeFileSync(filePath, 'different file');
      return open(...args);
    });
    expect((await getHandler()(new Request(url))).status).toBe(403);
    expect(files[0].fd).toBe(-1);
    expect(streams).toHaveLength(0);
  });
});

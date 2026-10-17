import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("@/config/env", () => ({ getActiveMobileSessionRealm: () => 'global' }));
const disk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  copying: false,
  gate: undefined as Promise<void> | undefined,
  seq: 0,
  available: 10 * 1024 ** 3,
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async (_algorithm: string, text: string) =>
    createHash("sha256").update(text).digest("hex"),
  randomUUID: () => `copy-${++disk.seq}`,
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache", get availableDiskSpace() { return disk.available; } },
  Directory: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((p) => (typeof p === "string" ? p : p.uri))
        .join("/");
    }
    create() {}
    list() {
      return [...disk.files.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => new File(uri));
    }
  },
  File: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((p) => (typeof p === "string" ? p : p.uri))
        .join("/");
    }
    get exists() {
      return disk.files.has(this.uri);
    }
    get name() { return this.uri.split('/').at(-1)!; }
    moveSync(target: { uri: string }) {
      const bytes = disk.files.get(this.uri);
      if (!bytes) throw new Error('missing');
      disk.files.set(target.uri, bytes);
      disk.files.delete(this.uri);
      this.uri = target.uri;
    }
    get size() {
      return disk.files.get(this.uri)?.length ?? 0;
    }
    delete() {
      disk.files.delete(this.uri);
    }
    async text() { return new TextDecoder().decode(disk.files.get(this.uri)); }
    write(text: string) { disk.files.set(this.uri, new TextEncoder().encode(text)); }
    async copy(target: { uri: string }) {
      disk.copying = true;
      if (disk.gate) await disk.gate;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const bytes = disk.files.get(this.uri);
      if (!bytes) throw new Error("missing");
      disk.files.set(target.uri, bytes.slice());
      disk.copying = false;
    }
  },
}));
import { createRemoteMediaDiskCache } from '@/session/remoteMediaDiskCache';
import { createExpoRemoteMediaDiskCacheIO } from '@/session/remoteMediaDiskCacheExpo';
import { createPeerFileCache } from "@/device-link/peerFileCache";
import { createMobileHtmlPreviewCache } from '@/session/mobileHtmlPreviewCache';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { File } from 'expo-file-system';
import { FILE_PEER_MAX_BYTES } from '@cindy/device-link';
import { remoteFileMediaUrl } from '@/session/fileBrowserGallery';
import {
  clearPeerMedia,
  peerMediaUri,
  recordPeerMedia,
  releasePeerMedia,
} from "@/device-link/peerFileRegistry";
afterEach(() => {
  setMobileAuthOwner(null);
  clearPeerMedia();
  disk.gate = undefined;
  disk.copying = false;
  disk.available = 10 * 1024 ** 3;
});

// Cached previews have no fresh metadata: identity and owner fencing must hold locally.
it('restores preview bytes offline, isolates account/device/SSH, and rejects a copy crossing an account switch', async () => {
  setMobileAuthOwner('html-owner');
  const cache = createMobileHtmlPreviewCache('desktop-a', '/site')!;
  const input = new File('file:///input.html');
  input.write('<p>Cached</p>');
  // A transfer saved before cache-first previews existed must also open offline.
  const transfer = await createPeerFileCache(JSON.stringify(['global', 'html-owner']));
  const meta = { ...metadata, size: input.size };
  const media = { ossKey: '', ...meta };
  recordPeerMedia(media, input.uri, () => {});
  await transfer.store('desktop-a', remoteFileMediaUrl('/site/index.html', undefined, undefined,
    { baseDir: '/site', maxBytes: FILE_PEER_MAX_BYTES }), meta, media);
  const copy = new File('file:///restored.html');
  expect(await cache.copy('index.html', copy)).toBe(input.size);
  expect(await copy.text()).toBe('<p>Cached</p>');
  expect(await cache.copy('index.html', new File('file:///too-large.html'), 1)).toBeNull();
  expect(disk.files.has('file:///too-large.html')).toBe(false);
  await cache.store('index.html', input, 'text/html');
  expect(await createMobileHtmlPreviewCache('desktop-b', '/site')!.copy('index.html', copy)).toBeNull();
  const ssh = { sessionId: 's', remoteHostId: 'ssh', workdir: '/site' };
  expect(await createMobileHtmlPreviewCache('desktop-a', '/site', ssh)!.copy('index.html', copy)).toBeNull();
  setMobileAuthOwner('other-html-owner');
  expect(await createMobileHtmlPreviewCache('desktop-a', '/site')!.copy('index.html', copy)).toBeNull();
  setMobileAuthOwner('html-owner');
  const restored = createMobileHtmlPreviewCache('desktop-a', '/site')!;
  let release!: () => void;
  disk.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = restored.copy('index.html', copy);
  await vi.waitFor(() => expect(disk.copying).toBe(true));
  setMobileAuthOwner('other-html-owner');
  release();
  expect(await pending).toBeNull();
  expect(copy.exists).toBe(false);
});

it('restores complete legacy manifests and rejects paths that the preview cannot publish', async () => {
  setMobileAuthOwner('manifest-owner');
  const cache = createMobileHtmlPreviewCache('desktop', '/site')!;
  const temporary = new File('file:///manifest.json');
  const file = { name: 'index.html', relPath: 'index.html', type: 'file' as const, size: 20 };
  await cache.storeManifest('index.html', [file], temporary);
  expect(await cache.manifest('index.html')).toEqual([file]);
  expect(temporary.exists).toBe(false);
  await cache.storeManifest('index.html', [file, { ...file, relPath: '../secret.html' }], temporary);
  expect(await cache.manifest('index.html')).toBeNull();
});
const metadata = { size: 5, mimeType: "text/html", version: "a".repeat(64) };
// PR #6299: the mocked cache IO hid empty-file rejection. Exercise the real cache
// and Expo adapter with an in-memory filesystem (unit): empty first writes and
// nonempty -> empty refresh must survive an index reload and shadow old transfers.
it.each(['', '<p>Old</p>'])('persists empty preview files after initial content %j', async (initial) => {
  const account = `empty-preview-${initial.length}`;
  const owner = JSON.stringify(['global', account]);
  setMobileAuthOwner(account);
  const cache = createMobileHtmlPreviewCache('desktop', '/site')!;
  const source = new File(`file:///input-${account}.html`);
  const destination = new File(`file:///output-${account}.html`);
  source.write('<p>Old transfer</p>');
  const transfer = await createPeerFileCache(owner);
  const meta = { ...metadata, size: source.size };
  const media = { ossKey: '', ...meta };
  recordPeerMedia(media, source.uri, () => {});
  await transfer.store('desktop', remoteFileMediaUrl('/site/index.html', undefined, undefined,
    { baseDir: '/site', maxBytes: FILE_PEER_MAX_BYTES }), meta, media);
  source.write(initial);
  await cache.store('index.html', source, 'text/html');
  source.write('');
  await cache.store('index.html', source, 'text/html');
  expect(await cache.copy('index.html', destination)).toBe(0);
  expect(await destination.text()).toBe('');
  const namespace = `files-${createHash('sha256').update(owner).digest('hex')}`;
  const reopened = createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO(namespace));
  const identity = JSON.stringify(['desktop', null, '/site', 'resource', 'index.html']);
  const hit = await reopened.lookup(`html-preview:${identity}`);
  expect(hit?.size).toBe(0);
  expect(await new File(hit!.uri).text()).toBe('');
});
async function seed(owner: string) {
  const cache = await createPeerFileCache(owner);
  const uri = `file:///received/${owner}`;
  disk.files.set(uri, Uint8Array.from([1, 2, 3, 4, 5]));
  const media = { ossKey: "", ...metadata };
  recordPeerMedia(media, uri, () => {
    disk.files.delete(uri);
  });
  await cache.store("device", "url", metadata, media);
  releasePeerMedia(uri);
  return cache;
}
it("awaits the asynchronous copy before returning, and consumer disposal leaves the durable copy intact", async () => {
  const cache = await seed("copy-owner");
  const result = await cache.read("device", "url", metadata, () => true);
  const uri = peerMediaUri(result!)!;
  expect(disk.files.get(uri)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
  expect(disk.copying).toBe(false);
  releasePeerMedia(uri);
  expect(
    await cache.read("device", "url", metadata, () => true),
  ).not.toBeNull();
  const other = await createPeerFileCache("other-owner");
  expect(await other.read("device", "url", metadata, () => true)).toBeNull();
});
it("discards a copy completed after cancellation and retains only the reusable source", async () => {
  const cache = await seed("cancel-owner");
  let resume!: () => void,
    active = true;
  disk.gate = new Promise((resolve) => {
    resume = resolve;
  });
  const before = new Set(disk.files.keys());
  const read = cache.read("device", "url", metadata, () => active);
  await vi.waitFor(() => expect(disk.copying).toBe(true));
  active = false;
  resume();
  expect(await read).toBeNull();
  expect(new Set(disk.files.keys())).toEqual(before);
});
it("invalidates a bad cache even if the forced transfer later fails, while consumer copies survive", async () => {
  const cache = await seed("refresh-owner");
  const old = await cache.read("device", "url", metadata, () => true);
  const uri = peerMediaUri(old!)!;
  await cache.invalidate("device", "url");
  expect(await cache.read("device", "url", metadata, () => true)).toBeNull();
  expect(disk.files.get(uri)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
});

it("reserves only one copy on a hit and preserves its source when space cannot be reclaimed", async () => {
  const cache = await seed("pressure-owner");
  const before = new Set(disk.files.keys());
  const reserve = 256 * 1024 ** 2;
  disk.available = reserve + metadata.size - 1;
  expect(await cache.read("device", "url", metadata, () => true)).toBeNull();
  expect(new Set(disk.files.keys())).toEqual(before);
  disk.available = reserve + metadata.size;
  const result = await cache.read("device", "url", metadata, () => true);
  expect(result).not.toBeNull();
  releasePeerMedia(peerMediaUri(result!)!);
  expect(new Set(disk.files.keys())).toEqual(before);
});

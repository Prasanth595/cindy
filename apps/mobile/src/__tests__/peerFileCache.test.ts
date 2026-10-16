import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const disk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  indexes: new Map<string, string>(),
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
    get size() {
      return disk.files.get(this.uri)?.length ?? 0;
    }
    delete() {
      disk.files.delete(this.uri);
    }
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
vi.mock("@/session/remoteMediaDiskCacheExpo", () => ({
  createExpoRemoteMediaDiskCacheIO: (namespace: string) => {
    const uri = (name: string) => `file:///cache/${namespace}/${name}`;
    return {
      ensureDir() {},
      readIndexText: async () => disk.indexes.get(namespace) ?? null,
      writeIndexText: (text: string) => {
        disk.indexes.set(namespace, text);
      },
      fileExists: (name: string) => disk.files.has(uri(name)),
      fileSize: (name: string) => disk.files.get(uri(name))?.length ?? -1,
      fileUri: uri,
      deleteFile: (name: string) => {
        disk.files.delete(uri(name));
      },
      listFiles: () =>
        [...disk.files.keys()]
          .filter((p) => p.startsWith(`file:///cache/${namespace}/`))
          .map((p) => p.split("/").at(-1)!),
      download: async (source: string, name: string) => {
        const bytes = disk.files.get(source);
        if (!bytes) return null;
        disk.files.set(uri(name), bytes.slice());
        return bytes.length;
      },
    };
  },
}));
import { createPeerFileCache } from "@/device-link/peerFileCache";
import {
  clearPeerMedia,
  peerMediaUri,
  recordPeerMedia,
  releasePeerMedia,
} from "@/device-link/peerFileRegistry";
afterEach(() => {
  clearPeerMedia();
  disk.gate = undefined;
  disk.copying = false;
  disk.available = 10 * 1024 ** 3;
});
const metadata = { size: 5, mimeType: "text/html", version: "a".repeat(64) };
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

import { Directory, File, Paths } from "expo-file-system";
import {
  CryptoDigestAlgorithm,
  digestStringAsync,
  randomUUID,
} from "expo-crypto";
import { validFileVersion, type DeviceFileResult } from "@cindy/device-link";
import { createRemoteMediaDiskCache } from "@/session/remoteMediaDiskCache";
import { createExpoRemoteMediaDiskCacheIO } from "@/session/remoteMediaDiskCacheExpo";
import {
  PEER_FILE_DISK_RESERVE_BYTES,
  recordPeerMedia,
  peerMediaUri,
  type LocalPeerMedia,
} from "./peerFileRegistry";

type Metadata = Pick<DeviceFileResult, "size" | "mimeType" | "version">;
/** Reuses the existing disk cache. Stable realm/account identity survives restarts;
 * auth generations belong to the caller's cancellation guard, never the disk key. */
const caches = new Map<string, ReturnType<typeof openPeerFileCache>>();
export function createPeerFileCache(owner: string) {
  let cache = caches.get(owner);
  if (!cache) {
    cache = openPeerFileCache(owner);
    caches.set(owner, cache);
    void cache.catch(() => {
      if (caches.get(owner) === cache) caches.delete(owner);
    });
  }
  return cache;
}
async function openPeerFileCache(owner: string) {
  const namespace = `files-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, owner)}`;
  const cache = createRemoteMediaDiskCache(
    createExpoRemoteMediaDiskCacheIO(namespace),
    {
      availableBytes: () => Paths.availableDiskSpace,
      reserveBytes: PEER_FILE_DISK_RESERVE_BYTES,
      persistAccess: true,
    },
  );
  return {
    // HTML previews deliberately allow a last-known copy before remote stat.
    // Keep these keys separate from the strictly versioned transfer cache.
    lookupPreview: async (identity: string, previousTransfer?: { device: string; url: string }) =>
      await cache.lookup(`html-preview:${identity}`) ?? (previousTransfer
        ? cache.lookup(JSON.stringify([previousTransfer.device, previousTransfer.url])) : null),
    storePreview: (identity: string, uri: string, mime: string, size: number) =>
      cache.store(`html-preview:${identity}`, uri, mime, size),
    prune: (size: number) => cache.prune(2 * size),
    invalidate: (device: string, url: string) =>
      cache.remove(JSON.stringify([device, url])),
    async read(
      device: string,
      url: string,
      metadata: Metadata | undefined,
      active: () => boolean,
    ) {
      if (!metadata || !validFileVersion(metadata.version)) return null;
      const source = JSON.stringify([device, url]);
      const hit = await cache.lookup(source, metadata.version);
      if (!active() || !hit || hit.size !== metadata.size) return null;
      // Only the consumer copy needs new space; keep its source during eviction.
      if (!(await cache.prune(metadata.size, source)) || !active()) return null;
      // The consumer owns a separate staging file; cache eviction never removes it.
      const directory = new Directory(
        Paths.cache,
        "remote-media-share",
        "file-peer",
      );
      directory.create({ intermediates: true, idempotent: true });
      const copy = new File(directory, randomUUID());
      const dispose = () => {
        if (copy.exists) copy.delete();
      };
      try {
        await new File(hit.uri).copy(copy);
        if (!active() || copy.size !== metadata.size) {
          dispose();
          return null;
        }
        const result = { ossKey: "", ...metadata };
        if (recordPeerMedia(result, copy.uri, dispose)) return result;
      } catch {
        /* A missing or evicted cache file is a miss. */
      }
      dispose();
      return null;
    },
    async store(
      device: string,
      url: string,
      metadata: Metadata | undefined,
      result: LocalPeerMedia,
    ) {
      if (
        !metadata ||
        !validFileVersion(metadata.version) ||
        result.version !== metadata.version ||
        result.size !== metadata.size
      )
        return;
      const uri = peerMediaUri(result);
      // Account for both the durable copy and the consumer's upcoming copy.
      if (!uri || !(await cache.prune(2 * result.size))) return;
      await cache.store(
        JSON.stringify([device, url]),
        uri,
        result.mimeType,
        result.size,
        metadata.version,
      );
    },
  };
}

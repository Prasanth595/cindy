/** Remote usage data only; each device/provider consumes the same snapshots as its local UI. */
import { useEffect, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;
/** A mount may reuse a live consumer's snapshot no older than this instead of re-reading. */
const MOUNT_REUSE_MS = 60_000;
function isSnapshotShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface RemoteDeviceUsageMirror<T> {
  useMirror(deviceId: string | null, providerId?: string): T | null;
  request(deviceId: string, providerId?: string, queueIfPending?: boolean, scheduling?: { background?: boolean }): void;
  resetForTest(): void;
}

export function createRemoteDeviceUsageMirror<T extends object>(cfg: {
  invokeChannel: string | null;
  decodeRead?: (value: unknown) => T | null | undefined;
  /** A read may return a richer contract than its invalidation push. */
  decodePush?: (value: unknown) => T | null | undefined;
  /** A failed reread cannot establish that a cached native snapshot still belongs to the current account. */
  clearOnReadFailure?: boolean;
  invokeArgs?: unknown[];
  pushChannel: string;
  defaultProviderId?: string;
  providerPushChannel?: string;
}): RemoteDeviceUsageMirror<T> {
  type Entry = {
    snapshot: T | null;
    revision: number;
    unsupportedUntil: number;
    pending: boolean;
    refreshQueued: boolean;
    refreshScheduling?: { background?: boolean };
    /** Last time a read or push settled this entry; 0 = never. */
    settledAt: number;
    owner: ReturnType<typeof getDataOwnerGeneration>;
    listeners: Set<() => void>;
  };
  const entries = new Map<string, Entry>();
  let cacheOwner = getDataOwnerGeneration();
  function entryFor(deviceId: string, providerId?: string): Entry {
    if (!isDataOwnerGenerationCurrent(cacheOwner)) {
      cacheOwner = getDataOwnerGeneration();
      entries.clear();
    }
    const key = JSON.stringify([deviceId, providerId ?? cfg.defaultProviderId ?? null]);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        snapshot: null,
        revision: 0,
        unsupportedUntil: 0,
        pending: false,
        refreshQueued: false,
        settledAt: 0,
        owner: cacheOwner,
        listeners: new Set(),
      };
      entries.set(key, entry);
    }
    return entry;
  }
  function apply(entry: Entry, snapshot: T | null): void {
    entry.snapshot = snapshot;
    entry.revision++;
    entry.settledAt = Date.now();
    for (const notify of entry.listeners) notify();
  }
  function request(deviceId: string, providerId?: string, queueIfPending = false, scheduling?: { background?: boolean }): void {
    if (!cfg.invokeChannel) return;
    const entry = entryFor(deviceId, providerId);
    if (entry.pending) {
      if (queueIfPending) {
        // An explicit recovery must keep its foreground priority even if a
        // background refresh was already queued behind the current read.
        if (!entry.refreshQueued || !scheduling?.background) entry.refreshScheduling = scheduling;
        entry.refreshQueued = true;
      }
      return;
    }
    if (Date.now() < entry.unsupportedUntil) return;
    const revision = entry.revision;
    const args = [...(cfg.invokeArgs ?? [])];
    // Keep the legacy builtin call shape; scoped reads must explicitly name their provider.
    if (providerId && providerId !== cfg.defaultProviderId) args.push(providerId);
    entry.pending = true;
    const read = scheduling
      ? window.electronAPI.deviceLink.invoke(deviceId, cfg.invokeChannel, args, scheduling)
      : window.electronAPI.deviceLink.invoke(deviceId, cfg.invokeChannel, args);
    void read
      .then((value) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        // Older hosts may ignore new optional arguments. Never accept their builtin snapshot
        // as a named account's usage; scoped handlers echo the provider they actually read.
        if (
          providerId &&
          providerId !== cfg.defaultProviderId &&
          value !== null &&
          (!isSnapshotShape(value) || value.providerId !== providerId)
        ) {
          if (cfg.clearOnReadFailure) apply(entry, null);
          return;
        }
        if (cfg.decodeRead) {
          const decoded = cfg.decodeRead(value);
          if (decoded !== undefined) apply(entry, decoded);
          else if (cfg.clearOnReadFailure) apply(entry, null);
        } else if (value === null || isSnapshotShape(value)) apply(entry, value as T | null);
        else if (cfg.clearOnReadFailure) apply(entry, null);
      })
      .catch((error: unknown) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        if (
          extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ||
          (error instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(error.message))
        ) {
          entry.unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_AFTER_MS;
        }
        if (cfg.clearOnReadFailure) apply(entry, null);
      })
      .finally(() => {
        entry.pending = false;
        if (entry.refreshQueued) {
          const queuedScheduling = entry.refreshScheduling;
          entry.refreshQueued = false;
          entry.refreshScheduling = undefined;
          if (isDataOwnerGenerationCurrent(entry.owner) && entry.listeners.size > 0) request(deviceId, providerId, false, queuedScheduling);
        }
      });
  }
  function useMirror(deviceId: string | null, providerId?: string): T | null {
    const entry = deviceId ? entryFor(deviceId, providerId) : null;
    const [, rerender] = useState(0);
    useEffect(() => {
      if (!deviceId || !entry) return;
      const notify = () => rerender((value) => value + 1);
      // Consumers of one device/account (session chip, model picker rail and rows) share this
      // entry, so a mount beside a live consumer reuses its fresh snapshot. With no listener a
      // clear push (logout, account switch) may have been missed, and pushes are also lost while
      // the link is down; both cases read the device again. Explicit request() always reads.
      const settled =
        entry.listeners.size > 0 &&
        entry.settledAt > 0 &&
        Date.now() - entry.settledAt < MOUNT_REUSE_MS;
      // A pending request from before an observation gap cannot stand in for
      // the fresh read required on resume. Concurrent live consumers still share it.
      const resumePending = entry.listeners.size === 0 && entry.pending;
      entry.listeners.add(notify);
      if (!settled) request(deviceId, providerId, resumePending);
      const off = window.electronAPI.deviceLink.onRemotePush((push, ownerStamp) => {
        if (
          push.deviceId !== deviceId ||
          !isDataOwnerGenerationCurrent(entry.owner) ||
          !isDeviceLinkRemotePushCurrent(push, ownerStamp)
        )
          return;
        const id = providerId ?? cfg.defaultProviderId;
        let value: unknown;
        if (
          push.channel === cfg.pushChannel &&
          (!cfg.defaultProviderId || id === cfg.defaultProviderId)
        ) {
          value = push.payload;
        } else if (
          push.channel === cfg.providerPushChannel &&
          isSnapshotShape(push.payload) &&
          push.payload.providerId === id
        ) {
          value = push.payload.snapshot;
        } else return;
        if (value !== null && !isSnapshotShape(value)) return;
        const decoded = cfg.decodePush ? cfg.decodePush(value) : (value as T | null);
        if (decoded === undefined) return;
        entry.unsupportedUntil = 0;
        apply(entry, decoded);
      });
      return () => {
        entry.listeners.delete(notify);
        off();
      };
    }, [deviceId, providerId, entry]);
    // Read the current entry during render: switching devices/accounts must not show the old value.
    return entry?.snapshot ?? null;
  }
  return {
    useMirror,
    request,
    resetForTest: () => {
      entries.clear();
      cacheOwner = getDataOwnerGeneration();
    },
  };
}

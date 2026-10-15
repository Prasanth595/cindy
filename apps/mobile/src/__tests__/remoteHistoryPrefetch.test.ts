import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectHistoryView, type HistoryViewPage, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { prefetchRemoteHistories } from '@/session/remoteHistoryPrefetch';
import { clearRemoteHistoryViews, getRemoteHistoryView, mountRemoteHistoryView } from '@/session/remoteHistoryViews';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteMessage, RemoteSession } from '@/session/types';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (name: string) => files.get(name) ?? null,
  write: async (name: string, value: string) => { files.set(name, value); },
  remove: async (name: string) => { files.delete(name); },
  files: async () => [...files.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));

const DEVICE = 'host-1';
const row = (id: string, second: number, content = id): RemoteMessage => ({
  id, clientId: id, sessionId: 's', role: 'assistant', content, toolUseId: null, agentMeta: null,
  createdAt: `2026-10-11T00:00:${String(second).padStart(2, '0')}.000Z`,
});
const page = (rows: RemoteMessage[]): HistoryViewPage<RemoteMessage> => ({
  version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null,
});
const snapshotOf = (rows: RemoteMessage[]): HistoryViewSnapshot<RemoteMessage> => ({
  ...page(rows), details: new Map(), expanded: new Set(), loading: false, ready: true, error: null,
});
function session(id: string, updatedAt: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id, userId: 'user-1', title: id, workingDir: '/repo', workspaceKind: 'project', model: 'claude',
    effort: 'medium', permissionMode: 'default', fastMode: false, status: 'active', agentKind: 'cc',
    pinnedAt: null, userSendAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt, ...patch,
  } as RemoteSession;
}

afterEach(async () => {
  clearRemoteHistoryViews();
  await clearHistoryDisk();
  remoteSessionStore.clear();
  setMobileAuthOwner(null);
});

describe('history read ahead after a list refresh', () => {
  it('fires on the first list and on a reconnect reseed, not on ordinary refreshes', () => {
    const seen: string[] = [];
    const off = remoteSessionStore.onSessionListRefreshAfterGap((deviceId) => seen.push(deviceId));
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:01.000Z')]);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:02.000Z')]);
    remoteSessionStore.requestReseed(DEVICE);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:02.000Z')]);
    off();
    expect(seen).toEqual([DEVICE, DEVICE]);
  });

  it('writes the latest page of a changed task so opening it restores the new reply', async () => {
    setMobileAuthOwner('user-1');
    const authority = historyDiskAuthority(DEVICE, 's');
    expect(await writeHistoryDisk(authority, snapshotOf([row('a1', 1)]))).toBe(true);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('s', '2026-10-11T00:00:09.000Z'),
      session('covered', '2026-10-11T00:00:00.000Z'),
      session('scheduled', '2026-10-11T00:00:09.000Z', { source: 'scheduler' }),
    ]);
    await writeHistoryDisk(historyDiskAuthority(DEVICE, 'covered'), snapshotOf([{ ...row('c1', 0), sessionId: 'covered' }]));
    const reader = { readHistoryView: vi.fn(async (sessionId: string) => page(
      sessionId === 's' ? [row('a1', 1), row('a2', 9, 'reply written while the phone was away')] : [])) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['s']);
    const cached = await readHistoryDisk(historyDiskAuthority(DEVICE, 's'));
    expect(cached?.items).toEqual(page([row('a1', 1), row('a2', 9, 'reply written while the phone was away')]).items);

    // The same version is not read again; a newer update is.
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView).toHaveBeenCalledTimes(1);
    // Clearing the disk cache (sign-out, account switch) invalidates that record.
    await clearHistoryDisk();
    reader.readHistoryView.mockClear();
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toContain('s');
    expect(await readHistoryDisk(historyDiskAuthority(DEVICE, 's'))).not.toBeNull();
    reader.readHistoryView.mockClear();
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:20.000Z')]);
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['s']);
  });

  it('leaves a mounted task to its own view and stops on a Host without history view', async () => {
    setMobileAuthOwner('user-1');
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('open', '2026-10-11T00:00:09.000Z'), session('other', '2026-10-11T00:00:08.000Z'),
    ]);
    const source = { readHistoryView: vi.fn(async () => page([])),
      readWorkDetails: vi.fn(async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null })),
      setHistoryExpanded: vi.fn(async () => undefined) };
    const release = mountRemoteHistoryView(getRemoteHistoryView(DEVICE, 'open', source), source, false);
    const reader = { readHistoryView: vi.fn(async (_sessionId: string): Promise<HistoryViewPage<RemoteMessage>> => {
      throw new Error('[CHANNEL_NOT_ALLOWED] History view is unavailable');
    }) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    release();
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['other']);
  });
});

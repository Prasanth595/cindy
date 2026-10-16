/**
 * 组设置与任务绑定的本机存储：坏形态清洗与容量淘汰；读写链路走真文件(临时目录)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-store-test-'));
let activeOwner = 'owner-test';

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => activeOwner === 'owner-test' ? path.join(tmpDir, name) : path.join(tmpDir, activeOwner, name),
  activeOwnerScopeKey: () => activeOwner,
}));

const store = await import('../store.js');
const bindings = await import('../bindings.js');
const locks = await import('../../device-link/crossProcessLock.js');

afterEach(() => { activeOwner = 'owner-test'; vi.restoreAllMocks(); });
afterAll(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

describe('provider group store', () => {
  it('drops invalid groups and empty groups when reading', () => {
    expect(store.__testing.normalize({
      groups: {
        anthropic: { strategy: 'least', members: [{ kind: 'local' }] },
        'bad id': { members: [{ kind: 'local' }] },
        empty: { members: [] },
      },
    })).toEqual({
      groups: {
        anthropic: {
          strategy: 'least',
          autoSwitch: true,
          members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
        },
      },
    });
  });

  it('writes, reads back and deletes a group', async () => {
    const written = await store.writeProviderGroup('anthropic', {
      strategy: 'order',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' }],
    });
    expect(written?.members).toHaveLength(2);
    expect(store.readProviderGroup('anthropic')?.strategy).toBe('order');
    await store.writeProviderGroup('anthropic', null);
    expect(store.readProviderGroup('anthropic')).toBeNull();
  });

  it('persists cleanup with group removal and retains it through restart, rejoin, and stale acknowledgements', async () => {
    const config = { strategy: 'least', members: [{ kind: 'local' }, { kind: 'share', agentDeviceId: 'share:a1', providerId: 'anthropic' }] };
    await store.writeProviderGroup('anthropic', config);
    await store.writeProviderGroup('anthropic', null);
    const token = store.listProviderGroupReshareCleanups()['share:a1'];
    expect(token).toBeDefined();
    const file = path.join(tmpDir, 'provider-group-prefs.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ reshareCleanups: { 'share:a1': token } });
    // 重新创建存储实例，不复用缓存，证明清理来自磁盘。
    vi.resetModules();
    const restarted = await import('../store.js');
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(token);
    await restarted.writeProviderGroup('anthropic', config);
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(token);
    await restarted.writeProviderGroup('anthropic', null);
    const nextToken = restarted.listProviderGroupReshareCleanups()['share:a1'];
    expect(nextToken).not.toBe(token);
    await restarted.completeProviderGroupReshareCleanup('share:a1', token);
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(nextToken);
    await restarted.completeProviderGroupReshareCleanup('share:a1', nextToken);
    expect(restarted.listProviderGroupReshareCleanups()).toEqual({});
  });

  it('only queues cleanup when a shared computer leaves its last group', async () => {
    const config = { members: [{ kind: 'share', agentDeviceId: 'share:overlap', providerId: 'anthropic' }] };
    await store.writeProviderGroup('anthropic', config);
    await store.writeProviderGroup('openai', config);
    await store.writeProviderGroup('anthropic', null);
    expect(store.listProviderGroupReshareCleanups()['share:overlap']).toBeUndefined();
    await store.writeProviderGroup('openai', null);
    expect(store.listProviderGroupReshareCleanups()['share:overlap']).toBeDefined();
  });

  it('preserves an unreadable file instead of overwriting its pending cleanups', async () => {
    const file = path.join(tmpDir, 'provider-group-prefs.json');
    const previous = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken-json');
    try {
      store.listProviderGroupReshareCleanups();
      await expect(store.writeProviderGroup('anthropic', null)).rejects.toThrow(/unreadable/);
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken-json');
    } finally {
      fs.writeFileSync(file, previous);
    }
  });
});

describe('provider group bindings', () => {
  it('keeps only well-formed bindings', () => {
    expect(bindings.__testing.normalize({
      sessions: {
        s1: { providerId: 'anthropic', memberKey: 'local', at: 5 },
        's 2': { providerId: 'anthropic', memberKey: 'local', at: 5 },
        s3: { providerId: 'bad id', memberKey: 'local' },
      },
    })).toEqual({ sessions: { s1: { providerId: 'anthropic', memberKey: 'local', at: 5 } } });
  });

  it('evicts the oldest bindings beyond capacity', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: bindings.MAX_PROVIDER_GROUP_BINDINGS + 3 }, (_, i) => [`s${i}`, { providerId: 'p', memberKey: 'local', at: i }]),
    );
    const pruned = bindings.__testing.prune(sessions);
    expect(Object.keys(pruned)).toHaveLength(bindings.MAX_PROVIDER_GROUP_BINDINGS);
    expect(pruned.s0).toBeUndefined();
    expect(pruned[`s${bindings.MAX_PROVIDER_GROUP_BINDINGS + 2}`]).toBeDefined();
  });

  it('writes and clears a binding', async () => {
    await bindings.writeProviderGroupBinding('s1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 42);
    expect(bindings.readProviderGroupBinding('s1')).toEqual({ providerId: 'anthropic', memberKey: 'device:mini:x', at: 42 });
    await bindings.writeProviderGroupBinding('s1', null);
    expect(bindings.readProviderGroupBinding('s1')).toBeNull();
  });

  it('releases bindings of removed computers and of deleted groups only', async () => {
    await bindings.writeProviderGroupBinding('a', { providerId: 'anthropic', memberKey: 'local' }, 1);
    await bindings.writeProviderGroupBinding('b', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 2);
    await bindings.writeProviderGroupBinding('c', { providerId: 'openai', memberKey: 'device:mini:y' }, 3);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']));
    expect(bindings.readProviderGroupBinding('a')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('b')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('a')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
  });

  it('does not write old cleanup releases into the new account after the binding write lock is released', async () => {
    activeOwner = 'new-owner';
    await bindings.writeProviderGroupBinding('scope-task', { providerId: 'anthropic', memberKey: 'local' }, 1);
    activeOwner = 'owner-test';
    await bindings.writeProviderGroupBinding('scope-task', { providerId: 'anthropic', memberKey: 'local' }, 1);
    const withLock = locks.withCrossProcessLock;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (...args) => {
      const result = await withLock(...args);
      // 落盘成功，但释放锁的异步收尾返回前切账号。
      activeOwner = 'new-owner';
      return result;
    });
    await bindings.pruneProviderGroupBindings('anthropic', null, 10);
    expect(bindings.readProviderGroupBinding('scope-task')).not.toBeNull();
    expect(bindings.isProviderGroupReleased('scope-task', { providerId: 'anthropic' })).toBe(false);
    activeOwner = 'owner-test';
    expect(bindings.readProviderGroupBinding('scope-task')).toBeNull();
  });

  it('remembers, per group, the tasks released by removing a computer or deleting the group', async () => {
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 1);
    await bindings.writeProviderGroupBinding('x2', { providerId: 'anthropic', memberKey: 'local' }, 2);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']), 10);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'openai' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x2', { providerId: 'anthropic' })).toBe(false);

    await bindings.markProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' }, 11);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: null })).toBe(false);
    // 单独一个文件：旧版本只读绑定文件，读不到也改写不到它。
    expect(fs.existsSync(path.join(tmpDir, 'provider-group-released.json'))).toBe(true);

    // 由同一个组重新分配(例如清空后当作新任务)时作废；别的组的分配不影响。
    await bindings.writeProviderGroupBinding('x1', { providerId: 'openai', memberKey: 'local' }, 12);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'local' }, 13);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(false);
  });

  it('keeps only well-formed release records', () => {
    expect(bindings.__testing.normalizeReleased({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
        c: { providerId: 'bad id', at: 3 },
        d: { providerId: 'anthropic', groupDeviceId: 'bad id', at: 4 },
        'e e': { providerId: 'anthropic', at: 5 },
      },
    })).toEqual({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
      },
    });
  });

  it('keeps bindings to a group on another computer in their own file, one group per task', async () => {
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini' }, 7);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 7 });
    // 本机的组只数本机那份：另一台电脑的组不进本机分配器的统计，也不被本机删组时清掉。
    expect(bindings.listProviderGroupBindings().r1).toBeUndefined();
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeDefined();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('r1')).not.toBeNull();
    // 降级后的旧版本只读本机那份，读不到它。
    const localFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(localFile.sessions?.r1).toBeUndefined();
    // 改归本机的组时另一份里的同一任务一并清掉。
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local' }, 8);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', at: 8 });
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeUndefined();
    await bindings.writeProviderGroupBinding('r1', null);
    expect(bindings.readProviderGroupBinding('r1')).toBeNull();
  });

  it('drops remote bindings without a valid group computer', () => {
    expect(bindings.__testing.normalizeRemote({
      sessions: {
        r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 },
        r2: { providerId: 'anthropic', memberKey: 'local' },
        r3: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'bad id' },
      },
    })).toEqual({ sessions: { r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 } } });
  });
});

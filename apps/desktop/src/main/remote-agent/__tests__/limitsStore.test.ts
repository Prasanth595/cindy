import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'a', pending: false }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (name: string) => state.root + '/' + state.owner + '/' + name,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
import { readRemoteAgentLimitsState, saveRemoteAgentLimits } from '../host/limitsStore';
import { readRemoteAgentIdleReleaseMinutes, readRemoteAgentIdleReleaseState, saveRemoteAgentIdleRelease } from '../controller/idleReleaseStore';
import { isRemoteAgentLimits } from '../../../shared/remoteAgentLimits';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-limit-store-'));
  state.owner = 'a'; state.pending = false;
});
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

describe('remote task limit overrides', () => {
  it('only persists supplied fields and preserves earlier explicit choices', async () => {
    await saveRemoteAgentLimits({ perDevice: 24 });
    expect(readRemoteAgentLimitsState()).toMatchObject({
      value: { perDevice: 24, total: 64 }, customizedKeys: ['perDevice'],
    });
    expect(JSON.parse(await fs.readFile(path.join(state.root, 'a', 'remote-agent-limits.json'), 'utf8'))).toEqual({ perDevice: 24 });
    await saveRemoteAgentLimits({ total: 80 });
    await saveRemoteAgentLimits({ perDevice: 16 });
    expect(readRemoteAgentLimitsState()).toMatchObject({
      value: { perDevice: 16, total: 80 }, customizedKeys: ['perDevice', 'total'],
    });
    await expect(saveRemoteAgentLimits({ total: 8 })).rejects.toThrow('INVALID_PARAMS');
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 16, total: 80 });
  });

  it('validates concurrent partial updates against the value inside the write lock', async () => {
    await saveRemoteAgentLimits({ perDevice: 16, total: 64 });
    const results = await Promise.allSettled([
      saveRemoteAgentLimits({ perDevice: 60 }), saveRemoteAgentLimits({ total: 32 }),
    ]);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(isRemoteAgentLimits(readRemoteAgentLimitsState().value)).toBe(true);
  });
  it('keeps explicit defaults, isolates accounts, and resets by deleting overrides', async () => {
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
    await saveRemoteAgentLimits({ perDevice: 16, total: 64 });
    expect(readRemoteAgentLimitsState().customizedKeys).toEqual(['perDevice', 'total']);
    await saveRemoteAgentLimits({ perDevice: 32, total: 128 });
    state.owner = 'b';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 16, total: 64 });
    state.owner = 'a';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 32, total: 128 });
    await saveRemoteAgentLimits(null);
    expect(readRemoteAgentLimitsState()).toMatchObject({ isCustomized: false, value: { perDevice: 16, total: 64 } });
  });
  it.each([
    { perDevice: 0, total: 64 }, { perDevice: 2, total: 1 },
    { perDevice: 1.5, total: 64 }, { perDevice: 16, total: 1001 },
    { perDevice: NaN, total: 64 }, { perDevice: 16, total: Infinity },
  ])('rejects invalid settings %j', async value => {
    expect(isRemoteAgentLimits(value)).toBe(false);
    await expect(saveRemoteAgentLimits(value)).rejects.toThrow('INVALID_PARAMS');
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
  });
  it('rejects writes during account teardown', async () => {
    state.pending = true;
    await expect(saveRemoteAgentLimits({ perDevice: 4, total: 8 })).rejects.toThrow('PRECONDITION_FAILED');
  });
});

// 使用方这台电脑的闲置释放设置(连接池)：同一套按账号存储的覆盖文件。
describe('idle release setting', () => {
  it('defaults to off (0), keeps explicit choices per account and resets by deleting the override', async () => {
    expect(readRemoteAgentIdleReleaseState()).toEqual({ value: { idleMinutes: 0 }, defaults: { idleMinutes: 0 }, isCustomized: false });
    await saveRemoteAgentIdleRelease({ idleMinutes: 10 });
    expect(readRemoteAgentIdleReleaseMinutes()).toBe(10);
    expect(JSON.parse(await fs.readFile(path.join(state.root, 'a', 'remote-agent-idle-release.json'), 'utf8'))).toEqual({ idleMinutes: 10 });
    await saveRemoteAgentIdleRelease({ idleMinutes: 0 });
    expect(readRemoteAgentIdleReleaseState().isCustomized).toBe(true);
    state.owner = 'b';
    expect(readRemoteAgentIdleReleaseState().isCustomized).toBe(false);
    state.owner = 'a';
    await saveRemoteAgentIdleRelease(null);
    expect(readRemoteAgentIdleReleaseState()).toMatchObject({ value: { idleMinutes: 0 }, isCustomized: false });
  });

  it('rejects invalid values and refuses saves during an account change', async () => {
    await expect(saveRemoteAgentIdleRelease({ idleMinutes: 121 })).rejects.toThrow('INVALID_PARAMS');
    state.pending = true;
    await expect(saveRemoteAgentIdleRelease({ idleMinutes: 5 })).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('treats a hand-edited invalid file as the default', async () => {
    await fs.mkdir(path.join(state.root, 'a'), { recursive: true });
    await fs.writeFile(path.join(state.root, 'a', 'remote-agent-idle-release.json'), JSON.stringify({ idleMinutes: 999 }));
    expect(readRemoteAgentIdleReleaseMinutes()).toBe(0);
  });
});

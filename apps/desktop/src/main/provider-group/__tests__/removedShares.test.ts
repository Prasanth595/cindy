/**
 * 原分享被删除或已退出(provider-groups.md §3)：已收到的分享名单完整可信时，组里指向已不在的分享的电脑移出组；
 * 名单说不准时什么都不动，分享只是暂停(仍在名单里)时保留。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { pruneRemovedShareMembers, type PruneRemovedShareMembersDeps } from '../removedShares';

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const MINI = member('device:mini:anthropic', 'device', 'mini');
const FROM_A = member('share:a1:anthropic', 'share', 'share:a1');
const FROM_D = member('share:d1:anthropic', 'share', 'share:d1');

function setup(received: ReadonlySet<string> | null) {
  let groups: Record<string, ProviderGroupConfig> = {
    anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI, FROM_A, FROM_D] },
    openai: { strategy: 'least', autoSwitch: true, members: [{ ...LOCAL, providerId: 'openai' }] },
  };
  const writeGroup = vi.fn(async (providerId: string, config: unknown) => {
    groups = { ...groups, [providerId]: config as ProviderGroupConfig };
    return config;
  });
  const deps: PruneRemovedShareMembersDeps = {
    confirmedShareIds: () => received,
    listGroups: () => groups,
    writeGroup,
    pruneBindings: vi.fn(async () => undefined),
    ownerKey: () => 'owner',
    changed: vi.fn(),
  };
  return { deps, writeGroup, groups: () => groups };
}

describe('removing computers whose share is gone', () => {
  it('removes only the shared-in computers whose share is no longer received, and their task bindings', async () => {
    const env = setup(new Set(['d1']));
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([FROM_A.key]);
    expect(env.groups().anthropic.members.map((m) => m.key)).toEqual([LOCAL.key, MINI.key, FROM_D.key]);
    expect(env.deps.pruneBindings).toHaveBeenCalledWith('anthropic', new Set([LOCAL.key, MINI.key, FROM_D.key]));
    expect(env.deps.changed).toHaveBeenCalledWith('anthropic');
    // 没有变化的组不写。
    expect(env.writeGroup).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the received list is not known to be complete', async () => {
    const env = setup(null);
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('keeps everything when every share is still received (paused shares stay in the list)', async () => {
    const env = setup(new Set(['a1', 'd1']));
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('stops when the account changes before writing', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.deps.listGroups = () => {
      owner = 'someone-else';
      return env.groups();
    };
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('does not prune the new account bindings when the account changes while the group write completes', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.writeGroup.mockImplementationOnce(async () => { owner = 'new-owner'; return null; });
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.deps.pruneBindings).not.toHaveBeenCalled();
    expect(env.deps.changed).not.toHaveBeenCalled();
  });

  it('does not publish old account changes or continue with other groups after binding cleanup changes account', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.deps.pruneBindings = vi.fn(async () => { owner = 'new-owner'; });
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.deps.pruneBindings).toHaveBeenCalledTimes(1);
    expect(env.deps.changed).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';

import type { ProviderShareModelUsageView } from '../../../../shared/providerShare';
import {
  deviceIdOfMemberKey,
  groupUsageByMember,
  mergeModelUsage,
  shareAgentDeviceIdOfMemberKey,
} from '../providerUsageBreakdown';

const usage = (partial: Partial<ProviderShareModelUsageView>): ProviderShareModelUsageView => ({
  kind: 'claude-code',
  providerId: 'xd',
  memberKey: 'local',
  model: 'opus',
  turns: 1,
  inputTokens: 10,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount: 1, currency: 'USD' },
  ...partial,
});

describe('mergeModelUsage', () => {
  it('adds the same model on the same computer and keeps computers apart', () => {
    const merged = mergeModelUsage([
      [usage({}), usage({ memberKey: 'device:studio:xd' })],
      [usage({ turns: 2, inputTokens: 5, amount: { amount: 0.5, currency: 'USD' } })],
    ]);
    expect(merged).toEqual([
      expect.objectContaining({ memberKey: 'local', turns: 3, inputTokens: 15, amount: { amount: 1.5, currency: 'USD' } }),
      expect.objectContaining({ memberKey: 'device:studio:xd', turns: 1 }),
    ]);
  });

  it('never adds amounts in different currencies', () => {
    const merged = mergeModelUsage([[usage({}), usage({ amount: { amount: 7, currency: 'CNY' } })]]);
    expect(merged).toEqual([expect.objectContaining({ memberKey: 'local', turns: 2, inputTokens: 20, amount: null })]);
  });
});

describe('groupUsageByMember', () => {
  it('lists every computer in the group in order, then removed ones, then earlier unattributed usage', () => {
    const groups = groupUsageByMember(
      [usage({ memberKey: null }), usage({ memberKey: 'device:gone:xd' }), usage({ memberKey: 'device:studio:xd' })],
      ['local', 'device:studio:xd'],
    );
    expect(groups.map((group) => [group.memberKey, group.inGroup, group.models.length])).toEqual([
      ['local', true, 0],
      ['device:studio:xd', true, 1],
      ['device:gone:xd', false, 1],
      [null, false, 1],
    ]);
  });

  it('treats a provider without a group as a group of just this computer', () => {
    const groups = groupUsageByMember([usage({}), usage({ memberKey: null, model: 'sonnet' })], ['local']);
    expect(groups.map((group) => [group.memberKey, group.inGroup, group.models.length])).toEqual([
      ['local', true, 1],
      [null, false, 1],
    ]);
  });

  it('merges accounts that share one physical computer', () => {
    const aliases = new Map([
      ['share:kai-1:xd', 'share-host:kai-pc'],
      ['share:kai-2:xd', 'share-host:kai-pc'],
    ]);
    const groups = groupUsageByMember(
      [
        usage({ memberKey: 'share:kai-1:xd' }),
        usage({ memberKey: 'share:kai-2:xd', providerId: 'xd-2', turns: 2, inputTokens: 20 }),
      ],
      ['local', 'share-host:kai-pc'],
      aliases,
    );
    expect(groups.map((group) => [group.memberKey, group.models.length])).toEqual([
      ['local', 0],
      ['share-host:kai-pc', 1],
    ]);
    expect(groups[1]!.models[0]).toMatchObject({ turns: 3, inputTokens: 30, memberKey: 'share-host:kai-pc' });
  });
});

describe('member keys', () => {
  it('reads the computer out of a group member key', () => {
    expect(deviceIdOfMemberKey('device:studio:anthropic-2')).toBe('studio');
    expect(deviceIdOfMemberKey('local')).toBeNull();
    expect(shareAgentDeviceIdOfMemberKey('share:abc:anthropic')).toBe('share:abc');
    expect(shareAgentDeviceIdOfMemberKey('device:studio:x')).toBeNull();
  });
});

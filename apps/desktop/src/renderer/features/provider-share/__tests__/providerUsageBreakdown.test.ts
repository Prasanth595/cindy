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

  it('can ignore the computer, and never adds amounts in different currencies', () => {
    const merged = mergeModelUsage(
      [[usage({}), usage({ memberKey: 'device:studio:xd', amount: { amount: 7, currency: 'CNY' } })]],
      { ignoreMember: true },
    );
    expect(merged).toEqual([expect.objectContaining({ memberKey: null, turns: 2, inputTokens: 20, amount: null })]);
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
});

describe('member keys', () => {
  it('reads the computer out of a group member key', () => {
    expect(deviceIdOfMemberKey('device:studio:anthropic-2')).toBe('studio');
    expect(deviceIdOfMemberKey('local')).toBeNull();
    expect(shareAgentDeviceIdOfMemberKey('share:abc:anthropic')).toBe('share:abc');
    expect(shareAgentDeviceIdOfMemberKey('device:studio:x')).toBeNull();
  });
});

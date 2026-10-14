/**
 * 组策略(provider-groups.md §5)：只分给可用、未暂停、没试过的电脑；优先未满载。
 */
import { describe, expect, it } from 'vitest';

import { pickProviderGroupMember, type SchedulableMember } from '../scheduler';

const m = (key: string, patch: Partial<SchedulableMember> = {}): SchedulableMember => ({
  key,
  usable: true,
  paused: false,
  running: 0,
  limit: 4,
  weight: 1,
  ...patch,
});

describe('pickProviderGroupMember', () => {
  it('skips unusable, paused and already-tried computers', () => {
    const members = [m('a', { usable: false }), m('b', { paused: true }), m('c'), m('d')];
    expect(pickProviderGroupMember(members, 'order')).toBe('c');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c']) })).toBe('d');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c', 'd']) })).toBeNull();
  });

  it('least busy picks the computer running the fewest tasks, ties by list order', () => {
    expect(pickProviderGroupMember([m('a', { running: 2 }), m('b', { running: 1 }), m('c', { running: 1 })], 'least')).toBe('b');
  });

  it('prefers computers under their limit and falls back to the least busy when all are full', () => {
    const members = [m('a', { running: 4 }), m('b', { running: 3 })];
    expect(pickProviderGroupMember(members, 'order')).toBe('b');
    expect(pickProviderGroupMember([m('a', { running: 5 }), m('b', { running: 4 })], 'order')).toBe('b');
  });

  it('round robin continues after the last picked computer and wraps around', () => {
    const members = [m('a'), m('b'), m('c')];
    expect(pickProviderGroupMember(members, 'round', { lastPicked: null })).toBe('a');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'a' })).toBe('b');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'c' })).toBe('a');
  });

  it('weight splits by the given weights', () => {
    const members = [m('a', { weight: 1 }), m('b', { weight: 3 })];
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.1 })).toBe('a');
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.5 })).toBe('b');
  });

  it('balances current usage and spreads similar usage across idle computers', () => {
    expect(pickProviderGroupMember([m('a', { usagePercent: 85 }), m('b', { usagePercent: 55, running: 2 })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 40, running: 2 }), m('b', { usagePercent: 45 })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 40, running: 2 }), m('b', { usagePercent: 46 })], 'usage')).toBe('a');
  });

  it('uses known usage first, with ordinary load balancing when no current usage is known', () => {
    expect(pickProviderGroupMember([m('unknown'), m('known', { usagePercent: 80 })], 'usage')).toBe('known');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b', { usagePercent: null })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 10, usable: false })], 'usage')).toBeNull();
  });

  it('keeps concurrency limits ahead of usage ranking, including the all-full fallback', () => {
    const full = m('low', { usagePercent: 10, running: 4 });
    expect(pickProviderGroupMember([full, m('high', { usagePercent: 80 })], 'usage')).toBe('high');
    expect(pickProviderGroupMember([full, m('other', { usagePercent: 5, running: 5 })], 'usage')).toBe('low');
  });
});

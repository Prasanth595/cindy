/**
 * 受邀者对某个分享打开的「凭证操作总是允许」(provider-sharing.md §9 第 7 条，2026-10-15)：
 * 默认关闭；按分享 + 成员记在本机；退出、分享消失或重新加入后失效；名单没确认完整的区域不清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderShareReceived } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ value: '' }));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(dir.value, ...parts),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

type TrustModule = typeof import('../providerShareCredentialTrust');

async function load(): Promise<TrustModule> {
  vi.resetModules();
  return import('../providerShareCredentialTrust');
}

function share(shareId: string, over: Partial<ProviderShareReceived> = {}): ProviderShareReceived {
  return {
    shareId,
    memberId: `member-${shareId}`,
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    hostDeviceId: 'host',
    deviceName: 'Host',
    owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
    status: 'active',
    hostOnline: true,
    hostCapable: true,
    ...over,
  };
}

beforeEach(() => {
  dir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-trust-'));
});

afterEach(() => {
  fs.rmSync(dir.value, { recursive: true, force: true });
});

describe('provider share credential trust', () => {
  it('is off by default and only applies to the share and member it was turned on for', async () => {
    const trust = await load();
    const a = share('a');
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(false);

    trust.setProviderShareCredentialTrusted(a, true);
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(true);
    expect(trust.isProviderShareCredentialTrusted(share('b'))).toBe(false);
    // 重新申请加入(成员变了)：旧的开关不沿用。
    expect(trust.isProviderShareCredentialTrusted({ ...a, memberId: 'member-new' })).toBe(false);

    trust.setProviderShareCredentialTrusted(a, false);
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(false);
  });

  it('survives a restart and stores no more than the share, member and region', async () => {
    const a = share('a', { owner: { displayName: 'Magi', avatarUrl: null, region: 'cn' } });
    (await load()).setProviderShareCredentialTrusted(a, true);
    expect((await load()).isProviderShareCredentialTrusted(a)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir.value, 'provider-share-credential-trust.json'), 'utf8'));
    expect(saved).toEqual({ trustedShares: { a: { memberId: 'member-a', region: 'cn' } } });
  });

  it('changes the setting from the settings page only for the member that page showed', async () => {
    const trust = await load();
    const a = share('a');
    let current: ProviderShareReceived | null = a;
    const find = (id: string) => (id === 'a' ? current : null);

    expect(trust.changeProviderShareCredentialTrust({ shareId: 'a', memberId: a.memberId, trusted: true }, find)).toBe(true);
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(true);
    expect(trust.changeProviderShareCredentialTrust({ shareId: 'a', memberId: a.memberId, trusted: false }, find)).toBe(false);
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(false);

    // 设置页上看到的是旧成员、名单里已是新成员(重新加入)：按找不到处理，不替新成员打开。
    current = { ...a, memberId: 'member-new' };
    expect(trust.changeProviderShareCredentialTrust({ shareId: 'a', memberId: a.memberId, trusted: true }, find)).toBeNull();
    expect(trust.isProviderShareCredentialTrusted(current)).toBe(false);
    // 分享已不在名单里。
    expect(trust.changeProviderShareCredentialTrust({ shareId: 'gone', memberId: 'x', trusted: true }, find)).toBeNull();
  });

  it('forgets a share after leaving it', async () => {
    const trust = await load();
    const a = share('a');
    trust.setProviderShareCredentialTrusted(a, true);
    trust.forgetProviderShareCredentialTrust('a');
    expect(trust.isProviderShareCredentialTrusted(a)).toBe(false);
  });

  it('drops shares that are gone only from regions whose list is confirmed complete', async () => {
    const trust = await load();
    const kept = share('kept');
    const gone = share('gone');
    const otherRegion = share('other', { owner: { displayName: 'Magi', avatarUrl: null, region: 'cn' } });
    for (const item of [kept, gone, otherRegion]) trust.setProviderShareCredentialTrusted(item, true);

    // 还没读到任何区域的名单：一条都不清。
    trust.pruneProviderShareCredentialTrust([], []);
    expect(trust.isProviderShareCredentialTrusted(gone)).toBe(true);

    trust.pruneProviderShareCredentialTrust([kept], ['global']);
    expect(trust.isProviderShareCredentialTrusted(kept)).toBe(true);
    expect(trust.isProviderShareCredentialTrusted(gone)).toBe(false);
    // 对方区域的名单没确认完整：保留。
    expect(trust.isProviderShareCredentialTrusted(otherRegion)).toBe(true);
  });

  it('ignores malformed entries in the saved file', async () => {
    const trust = await load();
    expect(trust.__testing.normalize({
      trustedShares: {
        ok: { memberId: 'm', region: 'global' },
        noMember: { region: 'global' },
        badRegion: { memberId: 'm', region: 'eu' },
        notObject: true,
      },
    })).toEqual({ trustedShares: { ok: { memberId: 'm', region: 'global' } } });
    expect(trust.__testing.normalize(null)).toEqual({ trustedShares: {} });
  });
});

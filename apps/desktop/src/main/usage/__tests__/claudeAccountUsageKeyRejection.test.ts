/**
 * 额度查询遇到 Cindy 网关 401 时上报 Cindy AI Key 失效(其余状态不上报)。
 * 只断言上报行为;配额解析契约见 claudeAccountUsageSource.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  outboundFetch: vi.fn(),
  report: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../authManager', () => ({
  getAuthState: () => ({
    mode: 'cloud',
    user: { id: 'user-1', membershipKind: 'org' },
    dataOwnerId: 'user-1',
    ownerGeneration: 1,
  }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/auth-adapters', () => ({
  readClaudeApiKey: () => 'usage-key-sent',
}));
vi.mock('../../maker-host/outbound-fetch', () => ({ outboundFetch: mocks.outboundFetch }));
vi.mock('../../maker-host/runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.test.invalid',
}));
vi.mock('../modelPricing', () => ({ getGatewayAccountCurrency: async () => 'USD' }));
vi.mock('../ledgerCurrency', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../model-access/gatewayKeyRejection', () => ({
  reportCindyGatewayKeyRejected: mocks.report,
}));

// This suite exercises the explicit old-server / Nova compatibility path.
vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: async () => undefined }));
let triggerClaudeAccountUsageRefresh: typeof import('../claudeAccountUsage')['triggerClaudeAccountUsageRefresh'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('claudeAccountUsage Cindy AI key rejection', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.outboundFetch.mockReset();
    mocks.report.mockReset();
    const credentials = await import('../../model-access/quotaCredentialState');
    credentials.noteQuotaCredentialStatus('cloud:user-1:1', {
      state: 'ok', source: 'server', endpoint: 'https://gateway.test.invalid', accountTier: null,
    });
    ({ triggerClaudeAccountUsageRefresh } = await import('../claudeAccountUsage'));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reports the sent key when user/info and daily/activity are rejected with 401', async () => {
    mocks.outboundFetch.mockImplementation(async () => jsonResponse({ error: 'invalid key' }, 401));

    await triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.outboundFetch.mock.calls) {
      expect(call[1]).toMatchObject({ headers: { Authorization: 'Bearer usage-key-sent' } });
    }
    expect(mocks.report).toHaveBeenCalledTimes(2);
    expect(mocks.report).toHaveBeenNthCalledWith(1, 'usage-key-sent');
    expect(mocks.report).toHaveBeenNthCalledWith(2, 'usage-key-sent');
  });

  it('reports only the endpoint that was rejected with 401', async () => {
    mocks.outboundFetch.mockImplementation(async (url: string) =>
      url.includes('/user/daily/activity')
        ? jsonResponse({ error: 'invalid key' }, 401)
        : jsonResponse({ spend: 1, max_budget: 10, budget_reset_at: null }),
    );

    await triggerClaudeAccountUsageRefresh(true);

    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith('usage-key-sent');
  });

  it.each([403, 500])('does not report HTTP %s', async (status) => {
    mocks.outboundFetch.mockImplementation(async () => jsonResponse({ error: 'nope' }, status));

    await triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('does not report successful quota responses', async () => {
    mocks.outboundFetch.mockImplementation(async (url: string) =>
      url.includes('/user/daily/activity')
        ? jsonResponse({ results: [] })
        : jsonResponse({ spend: 1, max_budget: 10, budget_reset_at: null }),
    );

    await triggerClaudeAccountUsageRefresh(true);

    expect(mocks.outboundFetch).toHaveBeenCalledTimes(2);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});

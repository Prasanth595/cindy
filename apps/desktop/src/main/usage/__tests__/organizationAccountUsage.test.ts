import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: fetch, ServerApiError: class extends Error { constructor(public code: string, public statusCode: number) { super(code); } } }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://models.example.test' }));
import { ServerApiError } from '../../serverApiClient.js';
import { readOrganizationAccountUsage } from '../organizationAccountUsage';
const valid = { spend: 12, maxBudget: 100, currency: 'CNY', budgetResetAt: '2026-11-01T00:00:00Z' };
beforeEach(() => { fetch.mockReset().mockResolvedValue(valid); });
describe('organization account usage', () => {
  it('uses authenticated Model Access and preserves the gateway currency', async () => {
    expect(await readOrganizationAccountUsage()).toMatchObject({ ...valid, todaySpend: null });
    expect(fetch).toHaveBeenCalledWith('/api/model-access/quota', expect.objectContaining({ redactErrorDetails: true, timeoutMs: 8000 }));
  });
  // Unit regression: the public reader discarded the server's daily spend. Existing
  // coverage only used null; todaySpend: 0 is the smallest input exposing the bug.
  // Missing/invalid daily data must preserve the monthly quota without inventing zero.
  it.each([1.25, 0])('preserves a valid daily spend of %s', async todaySpend => {
    fetch.mockResolvedValue({ ...valid, todaySpend });
    expect(await readOrganizationAccountUsage()).toMatchObject({ ...valid, todaySpend });
  });
  it.each([undefined, null, -1, NaN, Infinity, -Infinity, '1.25', false, {}])(
    'keeps the monthly quota when daily spend is %s', async todaySpend => {
      fetch.mockResolvedValue({ ...valid, todaySpend });
      expect(await readOrganizationAccountUsage()).toMatchObject({ ...valid, todaySpend: null });
    },
  );
  it.each([[404, 'NOT_FOUND'], [501, 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED']])('allows legacy fallback only for an unavailable capability', async (status, code) => {
    fetch.mockRejectedValue(new ServerApiError(code, status, 'safe'));
    expect(await readOrganizationAccountUsage()).toBeUndefined();
  });
  it.each([401, 403, 429, 500, 503])('never falls back after status %s', async status => {
    fetch.mockRejectedValue(new ServerApiError('ERROR', status, 'safe'));
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
  it('distinguishes unlimited from an unavailable response', async () => {
    fetch.mockResolvedValue({ ...valid, maxBudget: null });
    expect(await readOrganizationAccountUsage()).toBe('unlimited');
  });
  it.each([{ ...valid, spend: NaN }, { ...valid, currency: 'unknown' }])('does not invent a finite quota for malformed or unlimited data', async data => {
    fetch.mockResolvedValue(data);
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
});

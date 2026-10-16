import { beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => vi.resetModules());
const status = { state: 'ok', source: 'server', endpoint: 'https://gateway.example.test', accountTier: null } as const;
it('requires a successful current-process sync and matches both owner and endpoint', async () => {
  const state = await import('../quotaCredentialState');
  expect(state.quotaCredentialsReady('owner', status.endpoint)).toBe(false);
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'syncing' });
  expect(state.quotaCredentialsReady('owner', status.endpoint)).toBe(false);
  state.noteQuotaCredentialStatus('owner', status);
  expect(state.quotaCredentialsReady('owner', status.endpoint + '/')).toBe(true);
  expect(state.quotaCredentialsReady('other', status.endpoint)).toBe(false);
  expect(state.quotaCredentialsReady('owner', 'https://other.example.test')).toBe(false);
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'failed' });
  expect(state.quotaCredentialsReady('owner', status.endpoint)).toBe(false);
});
it('invalidates source changes and logout but not repeated successful synchronization', async () => {
  const state = await import('../quotaCredentialState');
  const changed = vi.fn();
  const off = state.onQuotaCredentialSourceChanged(changed);
  state.noteQuotaCredentialStatus('owner', status);
  const generation = state.quotaCredentialGeneration();
  state.noteQuotaCredentialStatus('owner', status);
  expect(state.quotaCredentialGeneration()).toBe(generation);
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'syncing' });
  state.noteQuotaCredentialStatus('owner', status);
  expect(state.quotaCredentialGeneration()).toBe(generation);
  state.noteQuotaCredentialStatus('owner', { ...status, endpoint: 'https://new.example.test' });
  expect(state.quotaCredentialGeneration()).toBe(generation + 1);
  state.noteQuotaCredentialStatus(null, { ...status, state: 'idle' });
  expect(state.quotaCredentialsReady('owner', status.endpoint)).toBe(false);
  expect(changed).toHaveBeenCalledTimes(3);
  off();
});

it.each([null, 'manual'] as const)('invalidates a removed/replaced source in non-ok state (%s)', async (source) => {
  const state = await import('../quotaCredentialState');
  const changed = vi.fn();
  state.noteQuotaCredentialStatus('owner', status);
  state.onQuotaCredentialSourceChanged(changed);
  const generation = state.quotaCredentialGeneration();
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'failed' });
  expect(changed).not.toHaveBeenCalled();
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'failed', source, endpoint: null });
  expect(state.quotaCredentialGeneration()).toBe(generation + 1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(state.quotaCredentialsReady('owner', status.endpoint)).toBe(false);
});

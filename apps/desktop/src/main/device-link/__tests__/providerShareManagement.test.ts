import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

import type { ProviderShareManagementCommand } from '../../../shared/providerManagement';

const state = vi.hoisted(() => ({ owner: 'owner-a', boundaryPending: false }));
const api = vi.hoisted(() => ({ createLink: vi.fn(), approve: vi.fn(), reject: vi.fn(), setMember: vi.fn() }));
const host = vi.hoisted(() => ({
  refresh: vi.fn(), snapshot: vi.fn(), quiet: vi.fn(), active: vi.fn(), decision: vi.fn(), member: vi.fn(),
}));
const listProviders = vi.hoisted(() => vi.fn());
const identityCard = vi.hoisted(() => vi.fn());
const remember = vi.hoisted(() => vi.fn());

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => 'host-device' }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders }),
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: remember }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: vi.fn() }));
vi.mock('../../usage/modelPricing.js', () => ({ getGatewayModelPricing: vi.fn(), getModelPriceQuote: vi.fn() }));
vi.mock('../../usage/turnCostCalculator.js', () => ({ computePriceQuoteTurnMoney: vi.fn(), normalizeModelIdForPricing: vi.fn() }));
vi.mock('../../usage/providerPartyUsageStore.js', () => ({ currentProviderPartyUsageStore: vi.fn() }));
vi.mock('../providerShareUsageStore.js', () => ({ getProviderShareUsageStore: vi.fn() }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true }), readLastKnownDeviceNames: vi.fn() }));
vi.mock('../providerShareApi.js', () => ({
  providerShareApi: api,
  fetchIdentityCard: identityCard,
  sha256Hex: (value: string) => value,
  providerShareLinkFor: () => 'https://cindy.app/s#test-link',
}));
vi.mock('../dispatch.js', () => ({
  getControllerDisplayName: vi.fn(), providerShareActiveControllers: vi.fn(),
  revokeProviderShareControllers: vi.fn(), setProviderShareAccess: vi.fn(),
}));
vi.mock('../providerShareHost.js', () => ({
  startProviderShareHost: vi.fn(), stopProviderShareHost: vi.fn(),
  refreshProviderShareHost: host.refresh, getProviderShareHostSnapshot: host.snapshot,
  clearProviderShareRequestQuiet: vi.fn(),
  providerShareGuestAccess: vi.fn(), providerShareGuestDenial: vi.fn(), ensureProviderSharePeerKnown: vi.fn(),
  quietProviderShareRequests: host.quiet, markProviderShareHostActive: host.active,
  applyLocalRequestDecision: host.decision, applyLocalMemberChange: host.member,
}));
vi.mock('../providerShareGuest.js', () => ({ startProviderShareGuest: vi.fn(), stopProviderShareGuest: vi.fn() }));
vi.mock('../providerShareGuestPrefs.js', () => ({ configureProviderShareGuestPrefs: vi.fn(), invalidateProviderShareGuestPrefsCache: vi.fn() }));
vi.mock('../providerShareGuestPrefsIpc.js', () => ({ setProviderShareCredentialConsentFromIpc: vi.fn() }));

import { executeProviderShareManagementCommand, registerProviderShareIpc, startProviderShareRuntime, stopProviderShareRuntime } from '../providerShareRuntime';

const createLink: ProviderShareManagementCommand = { action: 'create-link', providerId: 'anthropic' };
const LINK_ID = 'a'.repeat(64);
const mutations: ProviderShareManagementCommand[] = [
  { action: 'approve', requestId: 'r1' },
  { action: 'reject', requestId: 'r1' },
  { action: 'set-member', memberId: 'm1', status: 'remove' },
];

beforeEach(() => {
  vi.resetAllMocks();
  state.owner = 'owner-a';
  state.boundaryPending = false;
  listProviders.mockResolvedValue([{ id: 'anthropic', name: 'Anthropic', connected: true, agents: ['claude-code'] }]);
  identityCard.mockResolvedValue({ card: 'test-identity-card' });
  api.createLink.mockResolvedValue({ invitation: 'test-invitation', linkId: LINK_ID });
  api.approve.mockResolvedValue({ ok: true });
  api.reject.mockResolvedValue({ ok: true });
  api.setMember.mockResolvedValue({ status: 'removed' });
  host.refresh.mockResolvedValue(undefined);
  host.snapshot.mockReturnValue([{ requests: [{ requestId: 'r1' }], members: [{ memberId: 'm1' }] }]);
  startProviderShareRuntime(vi.fn());
});

afterEach(() => stopProviderShareRuntime());

describe('same-account share management during account transitions', () => {
  it.each([
    createLink, ...mutations,
    { action: 'owned', range: '7d' },
    { action: 'own-usage', providerId: 'anthropic', range: '7d' },
  ] satisfies ProviderShareManagementCommand[])('refuses $action at entry while teardown is pending', async (command) => {
    state.boundaryPending = true;
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(listProviders).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(api.createLink).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(mutations)('does not submit $action when teardown begins during membership refresh', async (command) => {
    host.refresh.mockImplementationOnce(async () => { state.boundaryPending = true; });
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(['provider lookup', 'identity card', 'link response'])('stops link creation when teardown begins during %s', async (stage) => {
    if (stage === 'provider lookup') listProviders.mockImplementationOnce(async () => { state.boundaryPending = true; return []; });
    if (stage === 'identity card') identityCard.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    if (stage === 'link response') api.createLink.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(identityCard).toHaveBeenCalledTimes(stage === 'provider lookup' ? 0 : 1);
    expect(api.createLink).toHaveBeenCalledTimes(stage === 'link response' ? 1 : 0);
    expect(host.active).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('discards a late $action result before changing local approval or membership state', async (command) => {
    const changeBoundary = async () => { state.boundaryPending = true; return { status: 'removed' }; };
    api.approve.mockImplementationOnce(changeBoundary);
    api.reject.mockImplementationOnce(changeBoundary);
    api.setMember.mockImplementationOnce(changeBoundary);
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.decision).not.toHaveBeenCalled();
    expect(host.member).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('management');
  });

  it('also discards a link response after a committed account switch', async () => {
    api.createLink.mockImplementationOnce(async () => { state.owner = 'owner-b'; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('executes $action once and updates local state when the account is stable', async (command) => {
    await expect(executeProviderShareManagementCommand(command)).resolves.toEqual({ ok: true });
    if (command.action === 'set-member') {
      expect(api.setMember).toHaveBeenCalledExactlyOnceWith('m1', 'remove');
      expect(host.member).toHaveBeenCalledExactlyOnceWith('m1', 'removed');
    } else if (command.action === 'approve' || command.action === 'reject') {
      expect(api[command.action]).toHaveBeenCalledExactlyOnceWith('r1');
      expect(host.decision).toHaveBeenCalledExactlyOnceWith('r1');
    }
  });

  it('creates and registers a link when the account is stable', async () => {
    await expect(executeProviderShareManagementCommand(createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link', linkId: LINK_ID });
    expect(api.createLink).toHaveBeenCalledTimes(1);
    expect(host.quiet).toHaveBeenCalledExactlyOnceWith('anthropic', LINK_ID);
    expect(remember).toHaveBeenCalledExactlyOnceWith('https://cindy.app/s#test-link', expect.any(String));
  });

  it('rejects an old server before exposing or registering a remote link', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(host.active).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it('still creates local share links with an old server', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    const handle = vi.spyOn(ipcMain, 'handle');
    try {
      registerProviderShareIpc();
      const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
      await expect(handler({} as Electron.IpcMainInvokeEvent, createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link' });
      expect(host.quiet).not.toHaveBeenCalled();
      expect(remember).toHaveBeenCalledTimes(1);
    } finally {
      handle.mockRestore();
    }
  });

  it('does not register a link when saving its host ownership fails', async () => {
    host.quiet.mockRejectedValueOnce(new Error('ownership save failed'));
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow('ownership save failed');
    expect(remember).not.toHaveBeenCalled();
  });
});

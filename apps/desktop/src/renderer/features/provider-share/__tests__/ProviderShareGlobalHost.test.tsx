// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetForTest, addModelFavorite, listModelFavorites, setModelFavoritesOwner } from '@/state/modelFavorites';
import { providerShareFavoriteSource } from '@/state/providerShareFavorites';

import type {
  ProviderShareOwnerState,
  ProviderShareRequestedEvent,
  ProviderShareSettledEvent,
  ProviderShareReceivedSnapshot,
} from '../../../../shared/providerShare';
import { ProviderShareGlobalHost } from '../ProviderShareGlobalHost';
import { resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => bus.auth }));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/features/cc-agent/lib/genericNewMakerRouteState', () => ({
  makeGenericNewMakerRouteState: () => ({ workspacePrompt: 'generic' }),
}));

const request = {
  requestId: 'req-1',
  displayName: 'Wang Yi',
  avatarUrl: null,
  region: 'global' as const,
  pairingCode: '4827',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function ownerState(requests = [request]): ProviderShareOwnerState {
  return {
    ready: true,
    shares: [
      { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI', createdAt: '2026-10-01T00:00:00Z', members: [], requests },
    ],
  };
}

const bus = vi.hoisted(() => ({
  auth: { dataOwnerId: 'recipient', dataOwnerGeneration: 1 },
  received: [] as ProviderShareReceived[],
  command: vi.fn(),
  requested: new Set<(event: ProviderShareRequestedEvent) => void>(),
  settled: new Set<(event: ProviderShareSettledEvent) => void>(),
  manage: new Set<(event: { providerId: string }) => void>(),
}));

function listen<T>(set: Set<T>) {
  return (cb: T) => {
    set.add(cb);
    return () => set.delete(cb);
  };
}

let currentOwner: ProviderShareOwnerState = ownerState();
const receivedShare: ProviderShareReceived = {
  shareId: 's1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host',
  deviceName: 'Host', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true,
};
const membership = (): ProviderShareReceivedSnapshot => ({
  ownerStamp: { dataOwnerId: bus.auth.dataOwnerId, ownerGeneration: bus.auth.dataOwnerGeneration },
  confirmedRegions: ['global'], received: bus.received,
});

beforeEach(() => {
  resetProviderShareStoreForTests();
  __resetForTest();
  window.localStorage.clear();
  bus.auth = { dataOwnerId: 'recipient', dataOwnerGeneration: 1 };
  bus.received = [receivedShare];
  setDataOwnerGeneration('recipient', 1);
  setModelFavoritesOwner('recipient');
  bus.command.mockReset();
  bus.requested.clear();
  bus.settled.clear();
  bus.manage.clear();
  currentOwner = ownerState();
  bus.command.mockImplementation(async (command: { action: string }) => {
    if (command.action === 'owned') return currentOwner;
    if (command.action === 'received') return [];
    if (command.action === 'received-snapshot') return membership();
    if (command.action === 'approve' || command.action === 'reject') {
      currentOwner = ownerState([]);
      return { ok: true };
    }
    throw new Error(`unexpected ${command.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerShare: {
        command: bus.command,
        onOwnedChanged: () => () => undefined,
        onReceivedChanged: () => () => undefined,
        onRequested: listen(bus.requested),
        onSettled: listen(bus.settled),
        onOpenJoin: () => () => undefined,
        onOpenManage: listen(bus.manage),
      },
    },
  });
});

afterEach(() => { cleanup(); resetProviderShareStoreForTests(); vi.restoreAllMocks(); });

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/cc-agent']}>
      <ProviderShareGlobalHost />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('ProviderShareGlobalHost', () => {
  it('resumes failed favorite cleanup after same-owner repair without a share push', async () => {
    currentOwner = ownerState([]);
    bus.received = [];
    addModelFavorite({ providerId: providerShareFavoriteSource(receivedShare), modelId: 'opus', agent: 'cc' });
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    const view = renderHost();
    await waitFor(() => expect(writes).toHaveBeenCalled());
    expect(listModelFavorites()).toHaveLength(1);
    writes.mockRestore();
    bus.auth = { ...bus.auth, dataOwnerGeneration: 2 };
    setDataOwnerGeneration('recipient', 2);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(listModelFavorites()).toEqual([]));
    expect(bus.command).toHaveBeenCalledWith(expect.objectContaining({
      action: 'received-snapshot',
      favoriteRecovery: { ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 2 }, regions: ['global'] },
    }));
  });

  it('refetches membership on same-owner repair and ignores an earlier generation reply', async () => {
    currentOwner = ownerState([]);
    addModelFavorite({ providerId: providerShareFavoriteSource(receivedShare), modelId: 'opus', agent: 'cc' });
    let finish!: (snapshot: ProviderShareReceivedSnapshot) => void;
    bus.command.mockImplementation(async (command: { action: string }) => {
      if (command.action === 'owned') return currentOwner;
      if (command.action === 'received') return bus.received;
      if (bus.auth.dataOwnerGeneration === 1) return new Promise((resolve) => { finish = resolve; });
      return membership();
    });
    const view = renderHost();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const old = { ...membership(), received: [] };
    bus.auth = { ...bus.auth, dataOwnerGeneration: 2 };
    setDataOwnerGeneration('recipient', 2);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith(expect.objectContaining({
      action: 'received-snapshot',
      favoriteRecovery: { ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 2 }, regions: ['global'] },
    })));
    await act(async () => { finish(old); });
    expect(listModelFavorites()).toHaveLength(1);
    bus.received = [];
    bus.auth = { ...bus.auth, dataOwnerGeneration: 3 };
    setDataOwnerGeneration('recipient', 3);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(listModelFavorites()).toEqual([]));
  });

  it('queues pending requests found at startup and approves from the dialog', async () => {
    renderHost();
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('providerShare.approve.title');
    expect(screen.getByTestId('provider-share-pairing-code').textContent).toBe('4827');

    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.approve' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(bus.command).toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
    const { toast } = await import('@/lib/toast');
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('providerShare.toast.approved'));
  });

  it('decide later keeps the request pending and does not reopen it for the same run', async () => {
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.later' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(bus.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));

    // main 重连后重新推送同一条申请：本次运行已弹过，不再弹。
    act(() => {
      for (const listener of bus.requested) {
        listener({ request, share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' } });
      }
    });
    expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull();
  });

  it('opens a dialog for a newly requested share', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith({ action: 'owned', range: 'month' }));
    act(() => {
      for (const listener of bus.requested) {
        listener({
          request: { ...request, requestId: 'req-9', displayName: 'Kai' },
          share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' },
        });
      }
    });
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('Kai');
  });

  it('toasts the result of a request whose dialog was closed', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.settled.size).toBeGreaterThan(0));
    act(() => {
      for (const listener of bus.settled) {
        listener({
          state: { requestId: 'req-x', status: 'approved', pairingCode: '1111', expiresAt: request.expiresAt },
          preview: {
            shareId: 'share-1',
            providerId: 'xd',
            providerLabel: 'Cindy AI',
            deviceName: "Magi's Mac Mini",
            owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
            state: 'used',
            expiresAt: request.expiresAt,
          },
        });
      }
    });
    const { toast } = await import('@/lib/toast');
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('providerShare.apply.toastApproved'),
      expect.anything(),
    );
  });

  it('opens the management page from a notification click', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.manage.size).toBeGreaterThan(0));
    act(() => {
      for (const listener of bus.manage) listener({ providerId: 'xd' });
    });
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers&shareProvider=xd');
  });
});

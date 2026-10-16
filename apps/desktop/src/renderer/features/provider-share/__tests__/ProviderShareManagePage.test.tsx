// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import type { ProviderOwnUsageView, ProviderShareOwnerState, ProviderShareRequestedEvent } from '../../../../shared/providerShare';
import { __testing as localGroupsTesting } from '../../provider-group/useLocalProviderGroups';
import { ProviderShareManagePage } from '../ProviderShareManagePage';
import { ProviderShareGlobalHost } from '../ProviderShareGlobalHost';
import {
  getProviderSharePendingRequests,
  getProviderSharePendingReshares,
  resetProviderShareStoreForTests,
} from '../providerShareStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [
    { deviceId: 'self', name: "Magi's Mac Mini", isSelf: true },
    { deviceId: 'studio', name: 'Studio', isSelf: false },
  ],
}));
const localCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string } }>,
}));
const remoteCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string }; group?: unknown }>,
  loading: false,
  error: null as string | null,
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => localCatalog }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => remoteCatalog }));
vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useAuth: () => ({ dataOwnerId: null, dataOwnerGeneration: 0 }),
  useOptionalAuthUser: () => ({ name: 'Magi', avatar: null }),
}));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));

const owned = (): ProviderShareOwnerState => ({
  ready: true,
  shares: [
    {
      shareId: 'share-1',
      providerId: 'xd',
      providerLabel: 'Cindy AI',
      createdAt: '2026-09-01T00:00:00Z',
      requests: [
        {
          requestId: 'req-1',
          displayName: 'Wang Yi',
          avatarUrl: null,
          region: 'global',
          pairingCode: '4827',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      members: [
        {
          memberId: 'mem-1',
          displayName: 'Lizi',
          avatarUrl: null,
          region: 'global',
          status: 'active',
          joinedAt: '2026-09-28T00:00:00Z',
          lastUsedAt: Date.now() - 60_000,
          runningTasks: 1,
          models: [
            {
              kind: 'claude-code',
              providerId: 'xd',
              memberKey: 'device:studio:xd-2',
              model: 'claude-opus-5-5',
              turns: 96,
              inputTokens: 1_310_000,
              outputTokens: 188_000,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              amount: { amount: 31.2, currency: 'USD' },
            },
          ],
        },
      ],
    },
    // 另一个供应商的分享不出现在这一页。
    { shareId: 'share-2', providerId: 'openai', providerLabel: 'OpenAI', createdAt: '2026-09-01T00:00:00Z', requests: [], members: [] },
  ],
});

const usageModel = (model: string, inputTokens: number, amount: number, memberKey: string | null = 'local') => ({
  kind: 'claude-code',
  providerId: 'xd',
  memberKey,
  model,
  turns: 3,
  inputTokens,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount, currency: 'USD' as const },
});

const ownUsage = (): ProviderOwnUsageView => ({
  providerId: 'xd',
  local: { deviceId: null, deviceName: null, lastUsedAt: Date.now() - 120_000, models: [usageModel('claude-sonnet-5', 41_000, 2.5)] },
  devices: [
    {
      deviceId: 'studio',
      deviceName: 'Old Studio Name',
      lastUsedAt: Date.now() - 3_600_000,
      models: [usageModel('claude-fable-5-1', 9_000, 1.25, 'device:studio:xd-2')],
    },
  ],
  relays: [],
});

/** 这台电脑上 xd 的供应商组：本机、Studio、一台分享来的电脑。 */
const xdGroup: ProviderGroupConfig = {
  strategy: 'least',
  autoSwitch: true,
  members: [
    { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'xd', limit: 4, weight: 1, paused: false },
    { key: 'device:studio:xd-2', kind: 'device', agentDeviceId: 'studio', providerId: 'xd-2', limit: 4, weight: 1, paused: false },
    { key: 'share:share-9:xd', kind: 'share', agentDeviceId: 'share:share-9', providerId: 'xd', limit: 4, weight: 1, paused: false },
  ],
};
let localGroups: Record<string, ProviderGroupConfig> = {};

const command = vi.fn();
let currentOwned: ProviderShareOwnerState;
const ownedListeners = new Set<() => void>();
const requestedListeners = new Set<(event: ProviderShareRequestedEvent) => void>();

beforeEach(() => {
  resetProviderShareStoreForTests();
  localGroupsTesting.reset();
  localGroups = {};
  currentOwned = owned();
  ownedListeners.clear();
  requestedListeners.clear();
  localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
  remoteCatalog.providers = [];
  remoteCatalog.loading = false;
  remoteCatalog.error = null;
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'owned') return currentOwned;
    if (cmd.action === 'own-usage') return ownUsage();
    if (cmd.action === 'received') return [];
    if (cmd.action === 'received-snapshot') return { ownerStamp: { dataOwnerId: null, ownerGeneration: 0 }, received: [], confirmedRegions: [] };
    if (cmd.action === 'set-member') return { ok: true };
    if (cmd.action === 'approve' || cmd.action === 'reject') {
      currentOwned = { ...currentOwned, shares: currentOwned.shares.map((share) => ({ ...share, requests: [] })) };
      return { ok: true };
    }
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerShare: {
        command,
        onOwnedChanged: (listener: () => void) => { ownedListeners.add(listener); return () => ownedListeners.delete(listener); },
        onRequested: (listener: (event: ProviderShareRequestedEvent) => void) => {
          requestedListeners.add(listener); return () => requestedListeners.delete(listener);
        },
        onReceivedChanged: () => () => undefined,
        onSettled: () => () => undefined,
        onOpenJoin: () => () => undefined,
        onOpenManage: () => () => undefined,
      },
      // 页面上方的供应商组一块(由 ProviderGroupSection 自己的测试覆盖)：这里只给一个空组。
      providerGroup: {
        command: async (cmd: {
          action: string;
          providerId?: string;
          request?: { action: string; command?: { action: string } };
        }) => {
          if (cmd.action === 'list') return localGroups;
          if (cmd.action === 'remote-manage') {
            const action = cmd.request?.command?.action;
            if (action === 'owned') return currentOwned;
            if (action === 'own-usage') return ownUsage();
            if (action === 'approve' || action === 'reject') {
              currentOwned = { ...currentOwned, shares: currentOwned.shares.map((share) => ({ ...share, requests: [] })) };
              return { ok: true };
            }
          }
          return { providerId: cmd.providerId, config: null, members: [] };
        },
        onChanged: () => () => undefined,
      },
    },
  });
});

afterEach(() => cleanup());

function renderPage(
  gate: 'on' | 'remote-off' | 'invocation-off' = 'on',
  options: { deviceId?: string; remoteProvider?: ProviderView; globalHost?: boolean; manualOnly?: boolean } = {},
) {
  const onBack = vi.fn();
  const view = render(
    <MemoryRouter>
      {options.globalHost && <ProviderShareGlobalHost manualOnly={options.manualOnly} />}
      <ProviderShareManagePage
        providerId="xd"
        providerName="Cindy AI"
        providerIcon={null}
        gate={gate}
        deviceId={options.deviceId}
        remoteProvider={options.remoteProvider}
        onBack={onBack}
      />
    </MemoryRouter>,
  );
  return { onBack, ...view };
}

describe('ProviderShareManagePage', () => {
  it('supports manual approval in secondary windows without automatic share subscriptions', async () => {
    renderPage('on', { globalHost: true, manualOnly: true });
    const row = await screen.findByTestId('provider-share-pending-row');
    expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull();
    expect(requestedListeners.size).toBe(0);
    // The management page reads owned once; a secondary host must not seed its own automatic queue.
    expect(command.mock.calls.filter(([cmd]) => cmd.action === 'owned')).toHaveLength(1);
    fireEvent.click(within(row).getByRole('button', { name: 'providerShare.approve.approve' }));
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('providerShare.approve.callout');
    fireEvent.click(within(dialog).getByRole('button', { name: 'providerShare.approve.approve' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-pending-row')).toBeNull());
    expect(command).toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
  });

  // §4.1/§7.2: management approval must show the same disclosure and route as automatic approval.
  // Existing host tests do not click this entry; keep the host real to catch duplicate modal ownership.
  it.each([
    { deviceId: undefined, grouped: true, callout: 'providerShare.approve.calloutGroup' },
    { deviceId: 'studio', grouped: true, callout: 'providerShare.approve.calloutGroup' },
    { deviceId: undefined, grouped: false, callout: 'providerShare.approve.callout:' },
    { deviceId: 'studio', grouped: false, callout: 'providerShare.approve.calloutRemote' },
  ])('shows approval disclosure before submitting on the provider’s computer ($deviceId, grouped=$grouped)', async ({ deviceId, grouped, callout }) => {
    currentOwned.quietRequestIds = ['req-1'];
    localGroups = !deviceId && grouped ? { xd: xdGroup } : {};
    remoteCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' }, ...(grouped ? { group: xdGroup } : {}) }];
    const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
    renderPage('on', { deviceId, globalHost: true });
    const row = await screen.findByTestId('provider-share-pending-row');
    fireEvent.click(within(row).getByRole('button', { name: 'providerShare.approve.approve' }));
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain(callout);
    const approval = { action: 'approve', requestId: 'req-1' };
    expect(command).not.toHaveBeenCalledWith(approval);
    expect(remoteCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      request: { action: 'manage-share', command: approval },
    }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'providerShare.approve.approve' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('provider-share-pending-row')).toBeNull());
    if (deviceId) {
      expect(remoteCommand).toHaveBeenCalledWith({
        action: 'remote-manage', deviceId, request: { action: 'manage-share', command: approval },
      });
      expect(command).not.toHaveBeenCalledWith(approval);
    } else expect(command).toHaveBeenCalledWith(approval);
  });

  it('keeps a postponed request pending and closes a selected request removed by a fresh list', async () => {
    currentOwned.quietRequestIds = ['req-1'];
    renderPage('on', { globalHost: true });
    const row = await screen.findByTestId('provider-share-pending-row');
    const approve = within(row).getByRole('button', { name: 'providerShare.approve.approve' });
    for (const close of ['later', 'escape']) {
      approve.focus();
      fireEvent.click(approve);
      const dialog = await screen.findByTestId('provider-share-approve-dialog');
      if (close === 'later') fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.later' }));
      else {
        // Escape from an action, after leaving the close icon's nested tooltip.
        act(() => { within(dialog).getByRole('button', { name: 'providerShare.approve.reject' }).focus(); });
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      }
      await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(approve));
      expect(getProviderSharePendingRequests().map((item) => item.request.requestId)).toEqual(['req-1']);
    }
    fireEvent.click(within(row).getByRole('button', { name: 'providerShare.approve.approve' }));
    await screen.findByTestId('provider-share-approve-dialog');
    currentOwned = owned();
    currentOwned.shares[0]!.requests = [];
    act(() => { for (const listener of ownedListeners) listener(); });
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(screen.queryByTestId('provider-share-pending-row')).toBeNull();
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'reject' }));
  });

  it('holds management approval while the local group list is pending', async () => {
    currentOwned.quietRequestIds = ['req-1'];
    let finish!: (groups: Record<string, ProviderGroupConfig>) => void;
    const original = window.electronAPI.providerGroup.command;
    vi.spyOn(window.electronAPI.providerGroup, 'command').mockImplementation((cmd) =>
      cmd.action === 'list' ? new Promise((resolve) => { finish = resolve; }) : original(cmd));
    renderPage('on', { globalHost: true });
    const row = await screen.findByTestId('provider-share-pending-row');
    fireEvent.click(within(row).getByRole('button', { name: 'providerShare.approve.approve' }));
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect((within(dialog).getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
    await act(async () => { finish({ xd: xdGroup }); });
    expect(dialog.textContent).toContain('providerShare.approve.calloutGroup');
    expect((within(dialog).getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses one approval dialog for a management selection, a late startup list and repeated requests', async () => {
    let finishStartup!: (state: ProviderShareOwnerState) => void;
    const original = command.getMockImplementation()!;
    let first = true;
    command.mockImplementation((cmd: { action: string }) => {
      if (cmd.action === 'owned' && first) {
        first = false;
        return new Promise((resolve) => { finishStartup = resolve; });
      }
      return original(cmd);
    });
    renderPage('on', { globalHost: true });
    const row = await screen.findByTestId('provider-share-pending-row');
    fireEvent.click(within(row).getByRole('button', { name: 'providerShare.approve.approve' }));
    await screen.findByTestId('provider-share-approve-dialog');
    await act(async () => { finishStartup(currentOwned); });
    const event = { request: currentOwned.shares[0]!.requests[0]!, share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' } };
    act(() => { for (const listener of requestedListeners) { listener(event); listener(event); } });
    expect(screen.getAllByTestId('provider-share-approve-dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.later' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    act(() => { for (const listener of requestedListeners) listener(event); });
    expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull();
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
  });

  it('places link creation in the title row and pending requests before group and usage', async () => {
    renderPage();
    await screen.findAllByTestId('provider-share-member-row');
    const title = screen.getByRole('heading', { name: /providerGroup\.page\.title/ });
    expect(within(title.parentElement!).getByRole('button', { name: 'providerShare.manage.createLink' })).toBeTruthy();
    expect(screen.queryByText('providerGroup.page.shareTitle')).toBeNull();
    expect(screen.queryByText(/providerShare\.manage\.description/)).toBeNull();
    const pending = screen.getByRole('region', { name: 'providerShare.manage.pending.title' });
    const usage = screen.getByRole('heading', { name: 'providerGroup.usage.title' });
    expect(pending.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const group = screen.getByRole('heading', { name: 'providerGroup.section.title' });
    expect(pending.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists pending requests and members for this provider only, and publishes pending requests', async () => {
    renderPage();
    expect(await screen.findAllByTestId('provider-share-member-row')).toHaveLength(1);
    expect(screen.getAllByTestId('provider-share-pending-row')).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({ action: 'owned', range: 'month' });
    expect(getProviderSharePendingRequests().map((item) => item.request.requestId)).toEqual(['req-1']);
    expect(screen.getByText(/providerShare\.manage\.members\.statusRunning/)).toBeTruthy();
    expect(screen.queryByText(/providerShare\.manage\.descriptionWithDevice/)).toBeNull();
  });

  it('lists usage by person: you first (this computer and your other computers together), then the people shared with', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('provider-usage-row');
    expect(rows.map((row) => row.getAttribute('data-usage-party'))).toEqual(['self', 'member:mem-1']);
    expect(command).toHaveBeenCalledWith({ action: 'own-usage', providerId: 'xd', range: 'month' });
    // 自己按人显示：当前登录账号的昵称，合计本机与 Studio(41k + 1k + 9k + 1k)。
    expect(rows[0]!.textContent).toContain('Magi');
    expect(rows[0]!.textContent).toContain('providerGroup.usage.selfTag');
    expect(rows[0]!.textContent).toContain('"tokens":"52.0k"');
    expect(rows[0]!.textContent).toContain('$3.75');
    // 用量从已分享的人一行移到了「用量」块。
    expect(screen.getByTestId('provider-share-member-row').textContent).not.toMatch(/members\.tokens/);
  });

  it('expands each person by computer in the group, listing every computer in group order', async () => {
    localGroups = { xd: xdGroup };
    const usage = ownUsage();
    usage.relays = [
      { deviceId: 'studio', deviceName: null, lastUsedAt: Date.now() - 600_000, models: [usageModel('claude-sonnet-5', 4_000, 0.5)] },
    ];
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') {
        const state = owned();
        // 加这个字段之前记的用量：没有区分电脑。
        state.shares[0]!.members[0]!.models.push({ ...usageModel('claude-sonnet-5', 2_000, 0.1, null) });
        return state;
      }
      if (cmd.action === 'own-usage') return usage;
      if (cmd.action === 'received') return [];
      throw new Error(`unexpected ${cmd.action}`);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/providerGroup\.usage\.descriptionGroup/)).toBeTruthy());
    const rows = await screen.findAllByTestId('provider-usage-row');
    // 经 Studio 的组转来的受邀者任务：看不到具体的人，按那台电脑一行。
    expect(rows.map((row) => row.getAttribute('data-usage-party'))).toEqual(['self', 'member:mem-1', 'relay:studio']);
    expect(rows[2]!.textContent).toContain('providerGroup.usage.relayName:{"device":"Studio"}');
    // 收起时写用了几台电脑。
    expect(rows[0]!.textContent).toContain('providerGroup.usage.computerCount:{\\"count\\":2}');

    fireEvent.click(screen.getByRole('button', { name: /providerGroup\.usage\.expandAria.*Magi/ }));
    const self = screen.getAllByTestId('provider-usage-row')[0]!;
    const members = within(self).getAllByTestId('provider-usage-member');
    expect(members.map((member) => member.getAttribute('data-member-key'))).toEqual([
      'local',
      'device:studio',
      'share:share:share-9',
    ]);
    expect(members[0]!.textContent).toContain('providerGroup.member.local');
    expect(members[0]!.textContent).toContain("Magi's Mac Mini");
    expect(members[0]!.textContent).toContain('81%');
    expect(members[0]!.textContent).toContain('claude-sonnet-5');
    expect(members[1]!.textContent).toContain('Studio');
    expect(members[1]!.textContent).toContain('19%');
    // 这段时间没用过的那台也列出来，只是没有数字。
    expect(members[2]!.textContent).toContain('providerGroup.member.shareComputerUnknown');
    expect(members[2]!.textContent).not.toContain('%');

    fireEvent.click(screen.getByRole('button', { name: /providerGroup\.usage\.expandAria.*Lizi/ }));
    const lizi = screen.getAllByTestId('provider-usage-row')[1]!;
    const keys = within(lizi).getAllByTestId('provider-usage-member').map((member) => member.getAttribute('data-member-key'));
    expect(keys).toEqual(['local', 'device:studio', 'share:share:share-9', '']);
    expect(lizi.textContent).toContain('providerGroup.usage.unattributed');
  });

  it('counts usage from multiple accounts on one physical computer once', async () => {
    localGroups = {
      xd: {
        ...xdGroup,
        members: [
          { ...xdGroup.members[0]! },
          { ...xdGroup.members[1]! },
          { ...xdGroup.members[2]!, hostDeviceId: 'kai-pc' },
          {
            ...xdGroup.members[2]!,
            key: 'share:share-10:xd',
            agentDeviceId: 'share:share-10',
            hostDeviceId: 'kai-pc',
          },
        ],
      },
    };
    const usage = ownUsage();
    usage.local!.models.push(
      usageModel('claude-sonnet-5', 2_000, 0.2, 'share:share-9:xd'),
      usageModel('claude-sonnet-5', 3_000, 0.3, 'share:share-10:xd'),
    );
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') return owned();
      if (cmd.action === 'own-usage') return usage;
      if (cmd.action === 'received') return [];
      throw new Error('unexpected action');
    });

    renderPage();
    const rows = await screen.findAllByTestId('provider-usage-row');
    expect(rows[0]!.textContent).toContain('providerGroup.usage.computerCount:{\\"count\\":3}');
    fireEvent.click(screen.getByRole('button', { name: /providerGroup\.usage\.expandAria.*Magi/ }));

    const members = within(screen.getAllByTestId('provider-usage-row')[0]!).getAllByTestId('provider-usage-member');
    expect(members.map((member) => member.getAttribute('data-member-key'))).toEqual([
      'local',
      'device:studio',
      'share-host:kai-pc',
    ]);
  });

  it('re-reads usage when the period changes', async () => {
    renderPage();
    await screen.findAllByTestId('provider-usage-row');
    fireEvent.click(screen.getByRole('radio', { name: 'providerShare.manage.members.range.7d' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'owned', range: '7d' }));
    expect(command).toHaveBeenCalledWith({ action: 'own-usage', providerId: 'xd', range: '7d' });
  });

  it('shows a provider without a group as a group of just this computer', async () => {
    renderPage();
    const rows = await screen.findAllByTestId('provider-usage-row');
    expect(screen.getByText(/providerGroup\.usage\.description:/)).toBeTruthy();
    // 和建了组的一样有摘要与占比，只是收起时不写用了几台电脑(只有一台)。
    expect(screen.getByTestId('provider-usage-summary')).toBeTruthy();
    expect(rows[0]!.textContent).not.toMatch(/computerCount/);

    fireEvent.click(screen.getByRole('button', { name: /providerGroup\.usage\.expandAria.*Magi/ }));
    const self = screen.getAllByTestId('provider-usage-row')[0]!;
    const members = within(self).getAllByTestId('provider-usage-member');
    // 本机一行在前；以前经组在 Studio 上运行的那部分排在后面，写已移出组。
    expect(members.map((member) => member.getAttribute('data-member-key'))).toEqual(['local', 'device:studio:xd-2']);
    expect(members[0]!.textContent).toContain('providerGroup.member.local');
    expect(members[0]!.textContent).toContain("Magi's Mac Mini");
    expect(members[1]!.textContent).toContain('providerGroup.usage.removedMember');

    fireEvent.click(screen.getByRole('button', { name: /providerGroup\.usage\.expandAria.*Lizi/ }));
    const lizi = screen.getAllByTestId('provider-usage-row')[1]!;
    expect(within(lizi).getByText('Opus 5.5')).toBeTruthy();
    expect(within(lizi).getAllByText('$31.20').length).toBeGreaterThan(0);
    expect(within(lizi).getByText('providerShare.manage.members.estimateNote')).toBeTruthy();
  });

  it('does not show zero for this computer when its usage could not be read', async () => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') return owned();
      if (cmd.action === 'received') return [];
      throw new Error('boom');
    });
    renderPage();
    const rows = await screen.findAllByTestId('provider-usage-row');
    expect(rows[0]!.getAttribute('data-usage-party')).toBe('self');
    expect(rows[0]!.textContent).toContain('providerShare.manage.loadFailed');
    expect(rows[0]!.textContent).not.toMatch(/members\.tokens/);
  });

  it('pauses and removes a member after confirmation', async () => {
    renderPage();
    await screen.findAllByTestId('provider-share-member-row');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.manage.members.pause' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'pause' }),
    );
    // 删除收在「⋯」里，行内没有直接的删除按钮。
    expect(screen.queryByRole('button', { name: /providerShare\.manage\.members\.removeAria/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: /providerGroup\.member\.moreAria/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /providerShare\.manage\.members\.removeAria/ }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'remove' }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  // 转分享(provider-sharing.md §4.3)：成员想经自己的供应商组把这里的供应商转给别人用，主人逐人处理。
  it.each([undefined, 'studio'])('handles reshare decisions on the provider’s computer (%s)', async (deviceId) => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') {
        const state = owned();
        state.shares[0]!.members[0]!.reshares = [
          { id: 'rs-pending', name: 'Carol', avatarUrl: null, state: 'pending', requestedAt: Date.now() - 1_000, decidedAt: null },
          { id: 'rs-approved', name: 'Dave', avatarUrl: null, state: 'approved', requestedAt: Date.now() - 9_000, decidedAt: Date.now() - 5_000 },
          { id: 'rs-rejected', name: 'Erin', avatarUrl: null, state: 'rejected', requestedAt: Date.now() - 9_000, decidedAt: Date.now() - 5_000 },
        ];
        return state;
      }
      if (cmd.action === 'own-usage') return ownUsage();
      if (cmd.action === 'received') return [];
      if (cmd.action === 'reshare-decide') return { ok: true };
      throw new Error(`unexpected ${cmd.action}`);
    });
    remoteCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
    const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
    if (deviceId) {
      remoteCommand.mockImplementation(async (cmd) => {
        if (cmd.action === 'remote-manage' && cmd.request.action === 'manage-share') {
          if (cmd.request.command.action === 'reshare-decide') return { ok: true };
          return command(cmd.request.command);
        }
        return { providerId: 'xd', config: null, members: [] };
      });
    }
    const expectDecision = async (id: string, decision: 'approve' | 'reject') => {
      const decidedCommand = { action: 'reshare-decide', id, decision };
      if (deviceId) {
        await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith({
          action: 'remote-manage', deviceId, request: { action: 'manage-share', command: decidedCommand },
        }));
        expect(command).not.toHaveBeenCalledWith(decidedCommand);
      } else {
        await waitFor(() => expect(command).toHaveBeenCalledWith(decidedCommand));
      }
    };
    renderPage('on', { deviceId });
    const pending = await screen.findByTestId('provider-share-reshare-row');
    expect(pending.textContent).toContain('Carol');
    expect(pending.textContent).toContain('providerShare.manage.reshare.applying:{"owner":"Lizi"}');
    expect(getProviderSharePendingReshares().map((item) => item.reshare.id)).toEqual(deviceId ? [] : ['rs-pending']);
    fireEvent.click(within(pending).getByRole('button', { name: 'providerShare.manage.reshare.approve' }));
    await expectDecision('rs-pending', 'approve');

    // 处理过的人挂在这个成员下方，默认收起成一行摘要：几个人在用、几个人没同意。
    const toggle = screen.getByTestId('provider-share-reshare-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain(
      'providerShare.manage.reshare.summaryUsing:{"count":1,"owner":"Lizi"} · providerShare.manage.reshare.summaryDeclined:{"count":1}',
    );
    expect(screen.queryAllByTestId('provider-share-reshare-item')).toHaveLength(0);

    // 点开后逐人列出：已同意的可撤回，拒绝的可改为同意。
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const decided = await screen.findAllByTestId('provider-share-reshare-item');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    expect(decided.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dave'),
      expect.stringContaining('Erin'),
    ]);
    fireEvent.click(await within(decided[0]!).findByRole('button', { name: /providerShare\.manage\.reshare\.revokeAria/ }));
    await expectDecision('rs-approved', 'reject');
    fireEvent.click(within(decided[1]!).getByRole('button', { name: /providerShare\.manage\.reshare\.approveAria/ }));
    await expectDecision('rs-rejected', 'approve');
  });

  it('summarizes reshares that were all declined without saying anyone uses it', async () => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') {
        const state = owned();
        state.shares[0]!.members[0]!.reshares = [
          { id: 'rs-rejected', name: 'Erin', avatarUrl: null, state: 'rejected', requestedAt: Date.now() - 9_000, decidedAt: Date.now() - 5_000 },
        ];
        return state;
      }
      if (cmd.action === 'own-usage') return ownUsage();
      if (cmd.action === 'received') return [];
      throw new Error(`unexpected ${cmd.action}`);
    });
    renderPage();
    const toggle = await screen.findByTestId('provider-share-reshare-toggle');
    expect(toggle.textContent).toContain(
      'providerShare.manage.reshare.summaryOwner:{"owner":"Lizi"} · providerShare.manage.reshare.summaryDeclined:{"count":1}',
    );
  });

  it('disables link creation and explains why when sharing is gated', async () => {
    renderPage('invocation-off');
    await screen.findAllByTestId('provider-share-member-row');
    const create = screen.getByRole('button', { name: 'providerShare.manage.createLink' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('providerShare.manage.gateInvocation');
  });

  it('shows the Claude subscription email notice on the management page', async () => {
    localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    expect(screen.getByTestId('provider-share-claude-email-callout').textContent).toContain(
      'providerShare.approve.calloutClaudeEmail',
    );
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not show the Claude subscription email notice for a non-Claude provider', async () => {
    localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    expect(screen.queryByTestId('provider-share-claude-email-callout')).toBeNull();
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['empty', 'unrelated'])('blocks a local management approval when its provider directory is %s', async (catalog) => {
    localCatalog.providers = catalog === 'empty' ? [] : [{ id: 'openai', source: 'builtin', auth: { method: 'oauth' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(command).not.toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
    const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'reject', requestId: 'req-1' }));
  });

  it.each(['empty', 'unrelated', 'loading', 'failed'])(
    'blocks a remote management approval when its provider directory is %s, even with an earlier provider snapshot',
    async (catalog) => {
      remoteCatalog.providers = catalog === 'empty' ? [] : [{
        id: catalog === 'unrelated' ? 'openai' : 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' },
      }];
      remoteCatalog.loading = catalog === 'loading';
      remoteCatalog.error = catalog === 'failed' ? 'directory unavailable' : null;
      const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
      renderPage('on', {
        deviceId: 'studio',
        remoteProvider: {
          id: 'xd', name: 'Cindy AI', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'oauth', native: 'claude' }, routing: {}, models: {}, connected: true,
        },
      });
      await screen.findAllByTestId('provider-share-pending-row');
      const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.click(approve);
      expect(remoteCommand).not.toHaveBeenCalledWith({
        action: 'remote-manage',
        deviceId: 'studio',
        request: { action: 'manage-share', command: { action: 'approve', requestId: 'req-1' } },
      });
      const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(false);
      fireEvent.click(reject);
      await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith({
        action: 'remote-manage',
        deviceId: 'studio',
        request: { action: 'manage-share', command: { action: 'reject', requestId: 'req-1' } },
      }));
    },
  );

  it('blocks approval on a remote management page until the provider directory is ready', async () => {
    remoteCatalog.loading = true;
    const view = renderPage('on', { deviceId: 'studio' });
    await screen.findAllByTestId('provider-share-pending-row');
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement).disabled).toBe(false);

    remoteCatalog.loading = false;
    remoteCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' } }];
    view.rerender(
      <ProviderShareManagePage
        providerId="xd"
        providerName="Cindy AI"
        providerIcon={null}
        gate="on"
        deviceId="studio"
        onBack={view.onBack}
      />,
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('provider-share-claude-email-callout')).toBeTruthy();
  });
});

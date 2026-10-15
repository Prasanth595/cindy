// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import type { ProviderOwnUsageView, ProviderShareOwnerState } from '../../../../shared/providerShare';
import { __testing as localGroupsTesting } from '../../provider-group/useLocalProviderGroups';
import { ProviderShareManagePage } from '../ProviderShareManagePage';
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
vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
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

beforeEach(() => {
  resetProviderShareStoreForTests();
  localGroupsTesting.reset();
  localGroups = {};
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'owned') return owned();
    if (cmd.action === 'own-usage') return ownUsage();
    if (cmd.action === 'received') return [];
    if (cmd.action === 'set-member' || cmd.action === 'approve' || cmd.action === 'reject') return { ok: true };
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerShare: { command, onOwnedChanged: () => () => undefined, onReceivedChanged: () => () => undefined },
      // 页面上方的供应商组一块(由 ProviderGroupSection 自己的测试覆盖)：这里只给一个空组。
      providerGroup: {
        command: async (cmd: { action: string; providerId: string }) =>
          cmd.action === 'list' ? localGroups : { providerId: cmd.providerId, config: null, members: [] },
        onChanged: () => () => undefined,
      },
    },
  });
});

afterEach(() => cleanup());

function renderPage(gate: 'on' | 'remote-off' | 'invocation-off' = 'on') {
  const onBack = vi.fn();
  render(<ProviderShareManagePage providerId="xd" providerName="Cindy AI" providerIcon={null} gate={gate} onBack={onBack} />);
  return { onBack };
}

describe('ProviderShareManagePage', () => {
  it('lists pending requests and members for this provider only, and publishes pending requests', async () => {
    renderPage();
    expect(await screen.findAllByTestId('provider-share-member-row')).toHaveLength(1);
    expect(screen.getAllByTestId('provider-share-pending-row')).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({ action: 'owned', range: 'month' });
    expect(getProviderSharePendingRequests().map((item) => item.request.requestId)).toEqual(['req-1']);
    expect(screen.getByText(/providerShare\.manage\.members\.statusRunning/)).toBeTruthy();
    expect(screen.getByText(/providerShare\.manage\.descriptionWithDevice/)).toBeTruthy();
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
      'device:studio:xd-2',
      'share:share-9:xd',
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
    expect(keys).toEqual(['local', 'device:studio:xd-2', 'share:share-9:xd', '']);
    expect(lizi.textContent).toContain('providerGroup.usage.unattributed');
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
    fireEvent.click(screen.getByRole('button', { name: /providerShare\.manage\.members\.removeAria/ }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'remove' }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  // 转分享(provider-sharing.md §4.3)：成员想经自己的供应商组把这里的供应商转给别人用，主人逐人处理。
  it('lists reshare requests under pending, and lets the owner withdraw or grant decided ones', async () => {
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
    renderPage();
    const pending = await screen.findByTestId('provider-share-reshare-row');
    expect(pending.textContent).toContain('Carol');
    expect(pending.textContent).toContain('providerShare.manage.reshare.applying:{"owner":"Lizi"}');
    expect(getProviderSharePendingReshares().map((item) => item.reshare.id)).toEqual(['rs-pending']);
    fireEvent.click(within(pending).getByRole('button', { name: 'providerShare.manage.reshare.approve' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'reshare-decide', id: 'rs-pending', decision: 'approve' }));

    // 处理过的人列在这个成员下方：已同意的可撤回，拒绝的可改为同意。
    const decided = screen.getAllByTestId('provider-share-reshare-item');
    expect(decided.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dave'),
      expect.stringContaining('Erin'),
    ]);
    fireEvent.click(within(decided[0]!).getByRole('button', { name: /providerShare\.manage\.reshare\.revokeAria/ }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'reshare-decide', id: 'rs-approved', decision: 'reject' }));
    fireEvent.click(within(decided[1]!).getByRole('button', { name: /providerShare\.manage\.reshare\.approveAria/ }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'reshare-decide', id: 'rs-rejected', decision: 'approve' }));
  });

  it('disables link creation and explains why when sharing is gated', async () => {
    renderPage('invocation-off');
    await screen.findAllByTestId('provider-share-member-row');
    const create = screen.getByRole('button', { name: 'providerShare.manage.createLink' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('providerShare.manage.gateInvocation');
  });
});

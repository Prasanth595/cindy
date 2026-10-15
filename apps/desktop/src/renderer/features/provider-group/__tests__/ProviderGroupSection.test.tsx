// @vitest-environment jsdom
/**
 * 「远程与分享」页的供应商组一块：建组(本机默认在组里)、组内电脑状态、参与分配开关、组策略与自动换电脑；
 * 再次打开时先显示已知的组，不从「读取中」重来。
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupView } from '../../../../shared/providerGroup';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import { memberStatusText, ProviderGroupSection } from '../ProviderGroupSection';
import { __testing as localGroupsTesting, useLocalProviderGroupsState } from '../useLocalProviderGroups';
import { __testing as groupViewTesting } from '../useProviderGroup';

let realLocale: ReturnType<typeof createInstance> | null = null;
const providerState = vi.hoisted(() => ({ providers: [
  { id: 'anthropic', connected: true, auth: { method: 'oauth', native: 'claude' } },
] }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => realLocale ? { t: realLocale.t, i18n: realLocale } : ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => providerState }));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));
// Radix 的浮层要 ResizeObserver,jsdom 里没有;行内「更多操作」菜单只需要验证菜单项的行为,
// 所以把菜单摊平成普通按钮,不去驱动真实的 Radix 开合。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
// 展开后的额度块单独测(GroupMemberQuota.test.tsx)；这里只看展开与读哪台。
vi.mock('../GroupMemberQuota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GroupMemberQuota')>()),
  GroupMemberQuota: ({ id, target, offline }: { id: string; target: unknown; offline: boolean }) => (
    <div data-testid="member-quota" id={id}>
      {JSON.stringify({ target, offline })}
    </div>
  ),
}));

const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
const MINI = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device' as const,
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'Mac mini',
  limit: 4,
  weight: 1,
  paused: false,
};

let stored: ProviderGroupConfig | null = null;
/** 按 member key 覆盖「正在运行」的台数；不设时本机 1、其余 0。 */
let running: Record<string, number> | null = null;
const command = vi.fn();

function viewOf(config: ProviderGroupConfig | null): ProviderGroupView {
  return {
    providerId: 'anthropic',
    config,
    members: (config?.members ?? []).map((m) => ({
      key: m.key,
      kind: m.kind,
      label: m.kind === 'local' ? 'Home Mac Studio' : m.label ?? m.key,
      state: m.paused ? 'paused' : m.kind === 'local' ? 'available' : 'cooling',
      running: running?.[m.key] ?? (m.kind === 'local' ? 1 : 0),
      limit: m.limit,
      weight: m.weight,
      paused: m.paused,
      ...(m.kind === 'local' ? {} : { coolingUntil: Date.UTC(2026, 9, 9, 7, 20) }),
    })),
  };
}

beforeEach(() => {
  realLocale = null;
  providerState.providers = [{ id: 'anthropic', connected: true, auth: { method: 'oauth', native: 'claude' } }];
  stored = null;
  running = null;
  localGroupsTesting.reset();
  groupViewTesting.reset();
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string; config?: ProviderGroupConfig }) => {
    if (cmd.action === 'list') return stored ? { anthropic: stored } : {};
    if (cmd.action === 'get') return viewOf(stored);
    if (cmd.action === 'candidates') {
      return [
        { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' },
        { key: 'share:s1:anthropic', kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', label: 'Studio-PC', providerName: 'Anthropic', ownerName: 'Kai', blocked: 'member' },
      ];
    }
    if (cmd.action === 'save') {
      stored = cmd.config ?? null;
      return viewOf(stored);
    }
    if (cmd.action === 'delete') {
      stored = null;
      return viewOf(null);
    }
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, { electronAPI: { providerGroup: { command, onChanged: () => () => undefined } } });
});

afterEach(() => cleanup());

describe('ProviderGroupSection', () => {
  it('shows the version and sharing update hint alongside the owner’s normal availability', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    const base = viewOf(stored);
    base.members[0] = { ...base.members[0], appVersion: '0.1.103', guestSupport: 'needs-update' };
    command.mockImplementation(async (cmd: { action: string }) => cmd.action === 'list' ? { anthropic: stored } : base);
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    await screen.findByText('v0.1.103');
    expect(screen.getByText('providerGroup.member.version.updateRequired')).toBeTruthy();
    expect(screen.getByTestId('provider-group-member').getAttribute('data-member-state')).toBe('available');
    expect(screen.getByText('providerGroup.member.runningCount:{"count":1}')).toBeTruthy();
  });

  it('creates a group with this computer plus the selected computers', async () => {
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    expect(await screen.findByText(/providerGroup\.section\.empty/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providerGroup.section.addComputer' }));
    const dialog = await screen.findByTestId('provider-group-add-dialog');
    const candidates = await within(dialog).findAllByTestId('provider-group-candidate');
    expect(candidates).toHaveLength(2);
    // 已在组里的不能再勾选。
    expect((candidates[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(candidates[0]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'providerGroup.add.confirm' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: 'save' })));
    const saved = command.mock.calls.find(([cmd]) => cmd.action === 'save')![0].config as ProviderGroupConfig;
    expect(saved.members.map((m) => m.key)).toEqual(['local', MINI.key]);
    expect(saved).toMatchObject({ strategy: 'least', autoSwitch: true });
    expect(await screen.findAllByTestId('provider-group-member')).toHaveLength(2);
  });

  // 转分享(provider-sharing.md §4.3)：分享来的电脑的主人是否同意本机分享出去的人经组使用它。
  it('shows whether the owner of a shared-in computer agreed to the people this computer shares with', async () => {
    realLocale = createInstance();
    await realLocale.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } }, interpolation: { escapeValue: false } });
    const SHARED = { key: 'share:s1:anthropic', kind: 'share' as const, agentDeviceId: 'share:s1', providerId: 'anthropic', limit: 4, weight: 1, paused: false };
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, SHARED] };
    const view = viewOf(stored);
    view.members[1] = {
      ...view.members[1],
      state: 'available',
      ownerName: 'Kai',
      reshare: {
        support: 'supported',
        guests: [
          { memberId: 'c', displayName: 'Carol', avatarUrl: null, state: 'pending' },
          { memberId: 'd', displayName: 'Dave', avatarUrl: null, state: 'approved' },
        ],
      },
    };
    command.mockImplementation(async (cmd: { action: string }) => (cmd.action === 'list' ? { anthropic: stored } : view));
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    await waitFor(() => expect(within(rows[1]).getByTestId('provider-group-member-reshare-summary').textContent)
      .toBe('1 位分享的人等待 Kai 同意'));
    // 本机这一行不显示。
    expect(within(rows[0]).queryByTestId('provider-group-member-reshare-summary')).toBeNull();
    expect(screen.queryByTestId('provider-group-member-reshare')).toBeNull();
    fireEvent.click(rows[1].querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const list = within(rows[1]).getByTestId('provider-group-member-reshare');
    expect(list.textContent).toContain('需要 Kai 逐人同意');
    const guests = within(list).getAllByTestId('provider-group-member-reshare-guest');
    expect(guests.map((guest) => guest.textContent)).toEqual(['CCarol等待同意', 'DDave已同意']);
  });

  it('expands a computer to show the quota of its own account', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    expect(screen.queryByTestId('member-quota')).toBeNull();
    const toggle = rows[1].querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const quota = within(rows[1]).getByTestId('member-quota');
    expect(toggle.getAttribute('aria-controls')).toBe(quota.id);
    expect(JSON.parse(quota.textContent!)).toEqual({
      target: { kind: 'device', deviceId: 'mini', providerId: MINI.providerId },
      offline: false,
    });
    fireEvent.click(rows[0].querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    expect(JSON.parse(within(rows[0]).getByTestId('member-quota').textContent!).target).toEqual({
      kind: 'local',
      providerId: 'anthropic',
    });
    fireEvent.click(toggle);
    expect(within(rows[1]).queryByTestId('member-quota')).toBeNull();
  });

  it('shows each computer with its state and lets the user pause one', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    expect(rows[0].getAttribute('data-member-state')).toBe('available');
    // 运行数在状态行，上限只在下拉里：同一个数字不出现两次。
    expect(within(rows[0]).getByText('providerGroup.member.runningCount:{"count":1}')).toBeTruthy();
    expect(within(rows[0]).getByText('providerGroup.member.limitOption:{"count":4}')).toBeTruthy();
    expect(within(rows[1]).queryByText(/providerGroup\.member\.runningCount/)).toBeNull();
    expect(rows[1].getAttribute('data-member-state')).toBe('cooling');
    expect(within(rows[1]).getByText(/providerGroup\.member\.status\.coolingUntil/)).toBeTruthy();
    // 本机与远程共用同一个开关；本机不能移出组。
    const localSwitch = within(rows[0]).getByRole('switch', {
      name: 'providerGroup.member.assignLocalAria:{"name":"providerGroup.member.local"}',
    });
    expect(localSwitch).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'providerGroup.member.remove' })).toBeNull();
    fireEvent.click(
      within(rows[1]).getByRole('switch', { name: 'providerGroup.member.assignAria:{"name":"Mac mini"}' }),
    );
    await waitFor(() => expect(stored?.members[1].paused).toBe(true));
    expect(await within(rows[1]).findByText('providerGroup.member.status.paused')).toBeTruthy();
    fireEvent.click(localSwitch);
    await waitFor(() => expect(stored?.members[0].paused).toBe(true));
    expect(await within(rows[0]).findByText('providerGroup.member.status.pausedLocal')).toBeTruthy();
    expect(within(rows[0]).getByText('providerGroup.member.runningCount:{"count":1}')).toBeTruthy();
    fireEvent.click(localSwitch);
    await waitFor(() => expect(stored?.members[0].paused).toBe(false));
    await waitFor(() => expect(within(rows[0]).queryByText('providerGroup.member.status.pausedLocal')).toBeNull());
  });

  it('says idle instead of staying silent when a computer is available with nothing running', async () => {
    running = { local: 0 };
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    // 每行都要报负载：跑 0 个时说「空闲」，不是什么都不显示。
    expect(within(rows[0]).getByText('providerGroup.member.status.idle')).toBeTruthy();
    expect(within(rows[0]).queryByText(/providerGroup\.member\.runningCount/)).toBeNull();
  });

  it('changes the group strategy and turns automatic switching off', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    await screen.findAllByTestId('provider-group-member');
    fireEvent.click(screen.getByRole('radio', { name: 'providerGroup.strategy.round' }));
    await waitFor(() => expect(stored?.strategy).toBe('round'));
    fireEvent.click(screen.getByRole('radio', { name: 'providerGroup.strategy.order' }));
    await waitFor(() => expect(stored?.strategy).toBe('order'));
    fireEvent.click(screen.getByRole('switch', { name: 'providerGroup.autoSwitch.label' }));
    await waitFor(() => expect(stored?.autoSwitch).toBe(false));
  });

  it('removes a computer after confirmation', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'providerGroup.member.remove' }));
    await waitFor(() => expect(stored?.members.map((m) => m.key)).toEqual(['local']));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  it('explains in Chinese that quota comes first for a disconnected subscription and shows an old usage group as least busy', async () => {
    realLocale = createInstance();
    await realLocale.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } }, interpolation: { escapeValue: false } });
    providerState.providers[0].connected = false;
    stored = { strategy: 'usage', autoSwitch: true, members: [LOCAL] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Claude" />);
    expect(await screen.findByText('能读取 Claude 订阅用量时，先用配额快重置的电脑，再选用量低的，相近时按组策略')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '最少占用' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('给最闲的那台')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '用量均衡' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '按顺序' }));
    await waitFor(() => expect(stored?.strategy).toBe('order'));
  });

  it.each([
    { kind: 'API-only', members: [LOCAL] },
    { kind: 'mixed local API and remote subscription', members: [LOCAL, MINI] },
  ])('explains when quota overrides the strategy for a $kind group', async ({ members }) => {
    realLocale = createInstance();
    await realLocale.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } }, interpolation: { escapeValue: false } });
    providerState.providers[0].auth.method = 'api-key';
    // Group views do not expose remote authentication types; the local connection cannot gate this explanation.
    stored = { strategy: 'order', autoSwitch: true, members };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    await screen.findAllByTestId('provider-group-member');
    expect(screen.getByText('能读取 Claude 订阅用量时，先用配额快重置的电脑，再选用量低的，相近时按组策略')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '按顺序' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio', { name: '用量均衡' })).toBeNull();
  });

  it('shows the quota hint for a subscription group', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    await screen.findAllByTestId('provider-group-member');
    expect(screen.getByText('providerGroup.strategy.quotaFirst')).toBeTruthy();
  });
});

describe('ProviderGroupSection reopened', () => {
  /** 让下一次「读组」(要逐台问状态，可能很慢)一直不回来。 */
  function holdNextGet() {
    command.mockImplementationOnce(() => new Promise(() => undefined));
  }

  it('shows the group it read last time right away while refreshing', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const first = render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    expect(await screen.findAllByTestId('provider-group-member')).toHaveLength(2);
    first.unmount();

    holdNextGet();
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = screen.getAllByTestId('provider-group-member');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-member-state')).toBe('available');
    expect(screen.queryByText('providerGroup.section.loading')).toBeNull();
  });

  it('lays out the computers from the local group settings before their live state arrives', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const local = renderHook(() => useLocalProviderGroupsState());
    await waitFor(() => expect(local.result.current.ready).toBe(true));

    holdNextGet();
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = screen.getAllByTestId('provider-group-member');
    expect(rows).toHaveLength(2);
    // 状态还没读回来：先写「检查中」，不是「读取中」或「未设置」。
    expect(rows[1].getAttribute('data-member-state')).toBe('loading');
    expect(within(rows[1]).getByText('providerGroup.member.status.checking')).toBeTruthy();
    expect(screen.queryByText(/providerGroup\.section\.empty/)).toBeNull();
  });

  it('shows the empty state at once when the local settings say there is no group', async () => {
    const local = renderHook(() => useLocalProviderGroupsState());
    await waitFor(() => expect(local.result.current.ready).toBe(true));

    holdNextGet();
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    expect(screen.getByText(/providerGroup\.section\.empty/)).toBeTruthy();
    await act(async () => undefined);
  });
});

describe('memberStatusText', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key) as unknown as Parameters<typeof memberStatusText>[0];
  const cooling = (coolingUntil: number) => ({
    key: 'device:mini:anthropic', kind: 'device' as const, label: 'Mac mini', state: 'cooling' as const,
    running: 0, limit: 4, weight: 1, paused: false, coolingUntil,
  });

  it('shows only the time for a cooldown that ends today, and the date for a later one', () => {
    const now = new Date(2026, 9, 11, 9, 30).getTime();
    expect(memberStatusText(t, cooling(new Date(2026, 9, 11, 16, 0).getTime()), 'en-US', now))
      .toBe('providerGroup.member.status.coolingUntil:{"time":"16:00"}');
    // 周上限：10 月 15 日才恢复，不能只写 16:00。
    expect(memberStatusText(t, cooling(new Date(2026, 9, 15, 16, 0).getTime()), 'en-US', now))
      .toBe('providerGroup.member.status.coolingUntil:{"time":"Oct 15 16:00"}');
  });
});

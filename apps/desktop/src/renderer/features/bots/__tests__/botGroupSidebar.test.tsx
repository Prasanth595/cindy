// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupOpenPlanSummary, BotGroupSummary } from '../../../../shared/botGroupChat';

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => null,
}));
// The shared creation entry reads the owner for import; this sidebar test does
// not mount the application authentication/provider runtime.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner' }),
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profiles: [] as unknown[],
  groups: [] as BotGroupSummary[],
  params: {} as { botId?: string; groupId?: string },
  pathname: '/bots',
  collapsed: false,
  registered: { node: null as ReactNode },
  islandActivity: new Map<string, { sessionId: string; phase: string; workingPhase?: string }>(),
  runningStatusOptions: null as null | {
    onSessionDone: (sessionId: string) => void;
    onSessionNeedsReply: (sessionId: string) => void;
  },
  sendNotification: vi.fn(),
  laneSentinel: Symbol('lane'),
  ownedTitle: vi.fn(),
  getSession: vi.fn(),
  confirm: vi.fn(),
  manage: vi.fn(),
  refreshGroups: vi.fn(),
  ownerGeneration: 1,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => mocks.ownerGeneration,
  isDataOwnerGenerationCurrent: (generation: number) => generation === mocks.ownerGeneration,
}));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));
vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: (_sessionId: string | undefined, options: typeof mocks.runningStatusOptions) => {
    mocks.runningStatusOptions = options;
    return { runningSessionIds: new Set<string>(), notifications: new Set<string>(), clearNotification: vi.fn() };
  },
}));
vi.mock('@/lib/sessionEventNotification', () => ({
  BOT_GROUP_LANE_SESSION: mocks.laneSentinel,
  botOwnedSessionNotificationTitle: (...args: unknown[]) => mocks.ownedTitle(...args),
  sendSessionEventNotification: (...args: unknown[]) => mocks.sendNotification(...args),
}));
vi.mock('@/lib/sessionService', () => ({ get: (...args: unknown[]) => mocks.getSession(...args) }));
vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.pathname, search: '', hash: '' }),
  useParams: () => mocks.params,
}));
vi.mock('../../feature-context', () => ({
  useSidebarCollapsedState: () => mocks.collapsed,
  useRegisterSidebarUpper: (node: ReactNode) => {
    mocks.registered.node = node;
  },
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  useBotUnreadCounts: () => ({}),
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(),
  setBotPinned: vi.fn(),
  duplicateBotProfile: vi.fn(),
  canonicalBotSessionId: (bot: { sessions?: Array<{ id: string; role?: string }> }) =>
    bot.sessions?.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('../botGroupStore', () => ({
  useBotGroupList: () => ({ groups: mocks.groups, loaded: true }),
  refreshBotGroups: mocks.refreshGroups,
}));
vi.mock('../BotDeleteDialog', () => ({ BotDeleteDialog: () => null }));
vi.mock('../BotGroupCreateDialog', () => ({
  BotGroupCreateDialog: () => <div role="dialog">create-group-dialog</div>,
}));
vi.mock('../BotRosterView', () => ({
  BotRosterView: () => <div role="dialog">create-teammate-dialog</div>,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ sessionId }: { sessionId?: string }) => <span>{`generation:${sessionId}`}</span>,
}));

import { BotsSidebar } from '../BotsSidebar';

function bot(id: string, name: string, extraSessions: unknown[] = []) {
  return {
    id,
    name,
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    lastMessagePreview: `${name} private preview`,
    sessions: [{ id: `${id}-chat`, kind: 'chat', role: 'canonical', title: name }, ...extraSessions],
  };
}

function group(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '周末出游',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'mimi',
    projectDir: null,
    lastMessage: { authorKind: 'bot', authorName: '阿布', preview: '下午\n有小概率阵雨', createdAt: 10 },
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function openPlan(overrides: Partial<BotGroupOpenPlanSummary> = {}): BotGroupOpenPlanSummary {
  return {
    id: 'p1',
    status: 'waiting',
    currentStep: 0,
    stepCount: 3,
    currentBotName: '咪咪',
    currentStepStatus: 'done',
    ...overrides,
  };
}

async function renderSidebar() {
  render(<BotsSidebar />);
  const view = render(<>{mocks.registered.node}</>);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.sendNotification.mockReset();
  mocks.ownedTitle.mockReset().mockResolvedValue(null);
  mocks.getSession.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.manage.mockReset().mockResolvedValue({ ok: true });
  mocks.refreshGroups.mockReset();
  mocks.ownerGeneration = 1;
  mocks.params = {};
  mocks.pathname = '/bots';
  mocks.collapsed = false;
  mocks.groups = [];
  mocks.islandActivity = new Map();
  mocks.runningStatusOptions = null;
  mocks.profiles = [
    bot('mimi', '咪咪', [{ id: 'lane-mimi', kind: 'group', role: 'group', title: 'group lane' }]),
    bot('xiaoman', '小满'),
  ];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { localDb: { messages: { onCreated: () => () => undefined } }, maker: { chatServer: {
      manage: mocks.manage, status: async () => ({ enabled: false }),
    } } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BotsSidebar group chats', () => {
  it('hides archived groups without an archive entry and finds their history through search', async () => {
    mocks.groups = [group(), group({ id: 'saved', name: '已完成的旅行', archived: true })];
    const view = await renderSidebar();
    expect(screen.getByText('周末出游')).toBeTruthy();
    expect(screen.queryByText('已完成的旅行')).toBeNull();
    expect(screen.queryByTestId('bot-archived-groups-toggle')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    fireEvent.change(input, { target: { value: '已完成的旅行' } });
    expect(screen.getByText('bots.archived')).toBeTruthy();
    fireEvent.click(screen.getByText('已完成的旅行'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/saved');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText('已完成的旅行')).toBeNull();
    mocks.groups = mocks.groups.map(item => ({ ...item, archived: false }));
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    expect(screen.getByText('已完成的旅行')).toBeTruthy();
  });

  it('searches archived group names and members without showing them in the default list', async () => {
    mocks.profiles = [];
    mocks.groups = Array.from({ length: 8 }, (_, i) => group({ id: 'saved-' + i,
      name: '历史群 ' + i, archived: true, members: i === 0 ? group().members : [],
    }));
    await renderSidebar();
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    fireEvent.change(input, { target: { value: '历史群 0' } });
    expect(screen.getByText('历史群 0')).toBeTruthy();
    expect(screen.queryByText('历史群 1')).toBeNull();
    fireEvent.change(input, { target: { value: '小满' } });
    expect(screen.getByText('历史群 0')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.queryByText('历史群 0')).toBeNull();
    expect(screen.getByText('bots.list.noResults')).toBeTruthy();
  });

  it('keeps an empty default list searchable when only one archived group remains and no bots exist', async () => {
    mocks.profiles = [];
    mocks.groups = [group({ archived: true, members: [{ ...group().members[0]!, name: 'Research Lead' }] })];
    await renderSidebar();
    expect(screen.queryByText('周末出游')).toBeNull();
    expect(document.querySelector('[data-bot-group-id]')).toBeNull();
    expect(screen.queryByTestId('bot-archived-groups-toggle')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    fireEvent.change(input, { target: { value: '  RESEARCH  ' } });
    expect(screen.getByText('周末出游')).toBeTruthy();
    expect(screen.getByText('bots.archived')).toBeTruthy();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByText('周末出游')).toBeNull();
  });

  const managedGroup = (archived = false) => group({ serverBacked: true, archived, revision: 7,
    members: [{ ...group().members[0]!, isOwned: true, role: 'owner' }],
  });
  const archiveKey = (archived = false) => 'bots.groupChat.server.settings.' + (archived ? 'unarchive' : 'archive');
  async function selectArchive(archived = false) {
    fireEvent.contextMenu(screen.getByText('周末出游').closest('button')!, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole('menuitem', { name: archiveKey(archived) }));
  }

  it.each([false, true])('confirms archive change (%s) with the current revision and waits for refresh', async archived => {
    mocks.groups = [managedGroup(archived)];
    const view = await renderSidebar();
    if (archived) fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    await selectArchive(archived);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'g1', action: {
      type: 'archive', archived: !archived, expectedRevision: 7,
    } }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: archiveKey(archived),
      confirmText: archiveKey(archived),
      description: 'bots.groupChat.server.settings.' + (archived ? 'unarchiveHint' : 'archiveHint'),
    }));
    expect(mocks.refreshGroups).toHaveBeenCalledOnce();
    expect(screen.getByText('周末出游')).toBeTruthy();
    mocks.groups = [managedGroup(!archived)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    if (!archived) expect(screen.queryByText('周末出游')).toBeNull();
    else expect(screen.getByText('周末出游')).toBeTruthy();
  });

  it('restores visible search focus after keyboard archive removes a default row', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    const row = screen.getByText('周末出游').closest('button')!;
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: archiveKey() }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());

    mocks.groups = [managedGroup(true)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'bots.list.search' })));
    // Let the browser reveal the search field if needed.
    expect(focus).toHaveBeenLastCalledWith();
  });

  it.each([false, true])('recovers focus when settings archives the selected group (route already cleared: %s)', async cleared => {
    mocks.params = { groupId: 'g1' };
    mocks.pathname = '/bots/groups/g1';
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    mocks.groups = [managedGroup(true)];
    if (cleared) { mocks.params = {}; mocks.pathname = '/bots/list'; }
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'bots.list.search' })));
  });

  it('keeps a new sidebar selection when settings archive finishes', async () => {
    mocks.params = { groupId: 'g1' };
    mocks.pathname = '/bots/groups/g1';
    mocks.groups = [managedGroup()];
    const view = await renderSidebar();
    const next = screen.getByText('咪咪').closest('button')!;
    act(() => next.focus());
    mocks.groups = [managedGroup(true)];
    mocks.params = {};
    mocks.pathname = '/bots/list';
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(document.activeElement).toBe(next);
  });

  it('recovers to an existing sidebar button when settings archive finishes with a collapsed sidebar', async () => {
    mocks.params = { groupId: 'g1' };
    mocks.pathname = '/bots/groups/g1';
    mocks.groups = [managedGroup()];
    mocks.collapsed = true;
    const view = await renderSidebar();
    mocks.groups = [managedGroup(true)];
    mocks.params = {};
    mocks.pathname = '/bots/list';
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector('button')));
  });

  it('restores focus to the moved group row after keyboard unarchive', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mocks.groups = [managedGroup(true)];
    const view = await renderSidebar();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    const row = screen.getByText('周末出游').closest('button')!;
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: archiveKey(true) }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());

    mocks.groups = [managedGroup(false)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('周末出游').closest('button')));
    expect(focus).toHaveBeenLastCalledWith();
  });

  it('keeps the search input focused when its last archived result is restored and the query is cleared', async () => {
    mocks.profiles = [];
    mocks.groups = [managedGroup(true)];
    const view = await renderSidebar();
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    fireEvent.change(input, { target: { value: '周末' } });
    await selectArchive(true);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
    act(() => input.focus());
    mocks.groups = [managedGroup(false)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('textbox', { name: 'bots.list.search' })).toBe(input);
    expect(document.activeElement).toBe(input);

    const row = screen.getByText('周末出游').closest('button')!;
    act(() => row.focus());
    expect(screen.queryByRole('textbox', { name: 'bots.list.search' })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('does not steal search focus when unarchive moves a filtered-out group', async () => {
    mocks.groups = [managedGroup(true)];
    const view = await renderSidebar();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    await selectArchive(true);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());

    fireEvent.change(input, { target: { value: 'missing' } });
    input.focus();
    mocks.groups = [managedGroup(false)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it.each([false, true])('restores the original row after archive confirmation is cancelled (%s)', async archived => {
    let settle!: (accepted: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { settle = resolve; }));
    mocks.groups = [managedGroup(archived)];
    await renderSidebar();
    if (archived) fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    const row = screen.getByText('周末出游').closest('button')!;
    row.focus();
    await selectArchive(archived);
    await waitFor(() => expect(document.activeElement).toBe(row));

    // Closing the real confirmation leaves body focused because its menu item
    // opener has already unmounted. The group row itself still exists.
    row.blur();
    await act(async () => { settle(false); });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
  });

  it.each([false, true])('restores the original row after archive request failure (%s)', async archived => {
    let settle!: (result: { ok: false; errorCode: string }) => void;
    mocks.manage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    mocks.groups = [managedGroup(archived)];
    await renderSidebar();
    if (archived) fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    const row = screen.getByText('周末出游').closest('button')!;
    row.focus();
    await selectArchive(archived);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(row));

    row.blur();
    await act(async () => { settle({ ok: false, errorCode: 'REVISION_CONFLICT' }); });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.getByRole('alert').textContent).toBe('bots.groupChat.server.settings.conflict');
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
  });

  it('does not steal search focus when unarchive keeps the group visible', async () => {
    mocks.groups = [managedGroup(true)];
    const view = await renderSidebar();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    await selectArchive(true);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());

    fireEvent.change(input, { target: { value: '周末' } });
    input.focus();
    mocks.groups = [managedGroup(false)];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('keeps cancelled archives untouched and blocks old-account confirmations', async () => {
    mocks.groups = [managedGroup()];
    mocks.confirm.mockResolvedValueOnce(false);
    await renderSidebar();
    await selectArchive();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(screen.getByText('周末出游')).toBeTruthy();
    mocks.confirm.mockImplementationOnce(async () => { mocks.ownerGeneration += 1; return true; });
    await selectArchive();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
  });

  it('blocks duplicate archive triggers while a confirmation is pending', async () => {
    mocks.groups = [managedGroup()];
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    await renderSidebar();
    await selectArchive();
    fireEvent.contextMenu(screen.getByText('周末出游').closest('button')!);
    const action = await screen.findByRole('menuitem', { name: archiveKey() });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(action);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    await act(async () => { accept(true); });
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  });

  it('shows archived history rather than stale speaking or plan prompts', async () => {
    mocks.groups = [group({ archived: true, speakingBotIds: ['mimi'], openPlan: openPlan() })];
    await renderSidebar();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.list.search' }), { target: { value: '周末' } });
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
    expect(screen.queryByText(/sidebar.planStepDone/)).toBeNull();
    expect(screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}')).toBeTruthy();
  });

  it('keeps failed archives visible and ignores old-account responses', async () => {
    mocks.groups = [managedGroup()];
    mocks.manage.mockResolvedValueOnce({ ok: false, errorCode: 'REVISION_CONFLICT' });
    await renderSidebar();
    await selectArchive();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('bots.groupChat.server.settings.conflict'));
    expect(screen.getByText('周末出游')).toBeTruthy();
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
    mocks.manage.mockImplementationOnce(async () => { mocks.ownerGeneration += 1; return { ok: true }; });
    await selectArchive();
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
    expect(mocks.refreshGroups).not.toHaveBeenCalled();
  });

  it('offers settings but no archive for ordinary members, with keyboard access', async () => {
    mocks.groups = [group({ serverBacked: true, revision: 1 })];
    await renderSidebar();
    fireEvent.keyDown(screen.getByText('周末出游').closest('button')!, { key: 'F10', shiftKey: true });
    expect(screen.queryByRole('menuitem', { name: archiveKey() })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.groupChat.settings.title' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
  });

  it('lists groups alongside teammates with an author preview and opens them', async () => {
    mocks.groups = [group(), group({ id: 'g2', name: '读书会', lastMessage: null, updatedAt: 1 })];
    mocks.params = { groupId: 'g1' };
    await renderSidebar();
    expect(screen.queryByText('bots.groupChat.sidebar.title')).toBeNull();
    const rows = screen.getAllByRole('button', { current: 'page' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('周末出游');
    expect(
      screen.getByText('bots.groupChat.sidebar.preview:{"name":"阿布","text":"下午 有小概率阵雨"}'),
    ).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.empty')).toBeTruthy();
    fireEvent.click(screen.getByText('读书会'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g2');

    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: 'bots.list.createTeammate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.groupChat.create.title' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-group-dialog');
  });

  it('opens teammate creation from the same plus menu', async () => {
    await renderSidebar();
    fireEvent.keyDown(screen.getByRole('button', { name: 'bots.list.createMenu' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.list.createTeammate' }));
    expect(screen.getByRole('dialog').textContent).toBe('create-teammate-dialog');
  });

  it('moves a group above older private chats on a new message while preserving pins', async () => {
    mocks.profiles = [{ ...bot('mimi', '咪咪'), lastMessageAt: 20 },
      { ...bot('xiaoman', '小满'), pinnedAt: 1 }];
    mocks.groups = [group()];
    const view = await renderSidebar();
    const order = () => Array.from(view.container.querySelectorAll('button'))
      .map(row => ['咪咪', '小满', '周末出游'].find(name => screen.getByText(name).closest('button') === row))
      .filter(Boolean);
    expect(order()).toEqual(['小满', '咪咪', '周末出游']);
    mocks.groups = [group({ lastMessage: { ...group().lastMessage!, createdAt: 30 } })];
    view.rerender(cloneElement(mocks.registered.node as ReactElement));
    expect(order()).toEqual(['小满', '周末出游', '咪咪']);
  });

  it('keeps joined groups visible when the account has no local teammates', async () => {
    mocks.profiles = [];
    mocks.groups = [group()];
    await renderSidebar();
    expect(screen.getByRole('button', { name: /周末出游/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.add' })).toBeNull();
  });

  it('searches both group names and members in the unified list', async () => {
    mocks.groups = [group(), ...Array.from({ length: 5 }, (_, i) =>
      group({ id: `other-${i}`, name: `其他群 ${i}`, members: [] }))];
    await renderSidebar();
    const input = screen.getByRole('textbox', { name: 'bots.list.search' });
    fireEvent.change(input, { target: { value: '出游' } });
    expect(screen.getByRole('button', { name: /周末出游/ })).toBeTruthy();
    expect(screen.queryByText('咪咪 private preview')).toBeNull();
    expect(screen.queryByRole('button', { name: /其他群/ })).toBeNull();
    fireEvent.change(input, { target: { value: '咪咪' } });
    expect(screen.getByRole('button', { name: /周末出游/ })).toBeTruthy();
    expect(screen.getByText('咪咪 private preview')).toBeTruthy();
  });

  it('shows the running mark on the group, not on the speaking teammate’s own row', async () => {
    mocks.groups = [group({ speakingBotIds: ['mimi'] })];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'searching' }],
    ]);
    await renderSidebar();
    const running = screen.getByTestId('bot-group-running');
    expect(running.textContent).toContain('咪咪');
    expect(running.textContent).toContain('generation:lane-mimi');
    // The teammate row keeps its private-chat preview.
    expect(screen.getByText('咪咪 private preview')).toBeTruthy();
    expect(screen.getAllByText('generation:lane-mimi')).toHaveLength(1);
  });

  it('previews a plan waiting for 开始 or for 继续 / 重试 instead of the latest message', async () => {
    mocks.groups = [
      group({ id: 'g1', name: '官网', openPlan: openPlan({ status: 'proposed', currentStep: null }) }),
      group({ id: 'g2', name: '周报', updatedAt: 9, openPlan: openPlan() }),
      group({
        id: 'g3',
        name: '海报',
        updatedAt: 8,
        openPlan: openPlan({ currentStep: 1, currentBotName: '小满', currentStepStatus: 'failed' }),
      }),
      group({
        id: 'g4',
        name: '旧版',
        updatedAt: 7,
        openPlan: openPlan({ currentBotName: null, currentStepStatus: null }),
      }),
    ];
    await renderSidebar();
    expect(screen.getByText('bots.groupChat.sidebar.planProposed:{"name":"咪咪"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planStepDone:{"name":"咪咪"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planStepFailed:{"name":"小满"}')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.sidebar.planWaitingAnonymous')).toBeTruthy();
    // The latest message only comes back once no plan needs the user.
    expect(screen.queryByText(/sidebar\.preview:/)).toBeNull();
    expect(screen.queryByTestId('bot-group-running')).toBeNull();
  });

  it('shows the step in progress as 分工 k/n in the running style', async () => {
    mocks.groups = [
      group({
        speakingBotIds: ['mimi'],
        openPlan: openPlan({ status: 'running', currentStep: 1, currentStepStatus: 'running' }),
      }),
    ];
    mocks.islandActivity = new Map([
      ['lane-mimi', { sessionId: 'lane-mimi', phase: 'running', workingPhase: 'editing' }],
    ]);
    await renderSidebar();
    const running = screen.getByTestId('bot-group-running');
    expect(running.textContent).toBe('bots.groupChat.sidebar.planRunning:{"step":2,"total":3,"name":"咪咪"}');
    expect(running.className).toContain('text-[var(--status-bar-accent)]');
  });

  it('shows the organizer working out a plan in the running style', async () => {
    mocks.groups = [group({ speakingBotIds: ['xiaoman'], planningBotId: 'xiaoman' })];
    await renderSidebar();
    expect(screen.getByTestId('bot-group-running').textContent).toBe(
      'bots.groupChat.sidebar.planPlanning:{"name":"小满"}',
    );
  });

  it('keeps the confirmation hint when the teammate doing a step waits for the user', async () => {
    mocks.groups = [
      group({
        speakingBotIds: ['mimi'],
        openPlan: openPlan({ status: 'running', currentStepStatus: 'running' }),
      }),
    ];
    mocks.islandActivity = new Map([['lane-mimi', { sessionId: 'lane-mimi', phase: 'needs-interaction' }]]);
    await renderSidebar();
    const running = screen.getByTestId('bot-group-running');
    expect(running.textContent).toContain('咪咪');
    expect(running.textContent).toContain('bots.groupChat.sidebar.waiting');
  });

  it('never sends system notifications for group lanes', async () => {
    await renderSidebar();
    const options = mocks.runningStatusOptions!;
    options.onSessionDone('lane-mimi');
    options.onSessionNeedsReply('lane-mimi');
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    options.onSessionDone('mimi-chat');
    expect(mocks.sendNotification).toHaveBeenCalledWith('mimi-chat', '咪咪', 'done');

    // A lane the cached profiles have not caught up with yet is re-checked.
    mocks.sendNotification.mockReset();
    mocks.getSession.mockResolvedValue({ id: 'lane-new', title: 'lane', source: 'bot' });
    mocks.ownedTitle.mockResolvedValue(mocks.laneSentinel);
    options.onSessionDone('lane-new');
    await waitFor(() => expect(mocks.ownedTitle).toHaveBeenCalledWith('lane-new'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

it('localizes the join preview without presenting its subject as a chat author', async () => {
  mocks.groups = [group({ lastMessage: { authorKind: 'system', authorName: 'Taylor',
    noticeCode: 'member-joined', preview: 'Fallback text', createdAt: 30 } })];
  await renderSidebar();
  expect(screen.getByText('bots.groupChat.notice.memberJoined:{"name":"Taylor"}')).toBeTruthy();
  expect(screen.queryByText(/Fallback text/)).toBeNull();
});

// @vitest-environment jsdom
import { createRef, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { AddTabDropdown } from '../AddTabDropdown';
import { __resetGlobalTabsForTest } from '../globalTabs';
import { __resetTabGroupsForTest } from '../tabGroups';

const m = vi.hoisted(() => ({
  ghosts: [] as unknown[],
  open: vi.fn(async () => undefined),
  rows: new Map<string, { remoteHostId?: string | null; deviceLinkDeviceId?: string | null }>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Radix 浮层在 jsdom 里不需要真的开合:菜单摊平成按钮,只验证有哪些项、点了做什么。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock('@/features/bots/botStore', () => ({
  useBotProfiles: () => [
    {
      id: 'bot-1',
      sessions: [
        { id: 'bot-main', role: 'canonical' },
        { id: 'bot-history', role: 'history' },
      ],
    },
  ],
  canonicalBotSessionId: (bot: { sessions: Array<{ id: string; role: string }> }) =>
    bot.sessions.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { findById: (id: string) => m.rows.get(id) ?? null } }));
vi.mock('../lib/openBotWorkbenchTab', () => ({ openBotWorkbenchTab: m.open }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => m.ghosts }));

function renderMenu(sessionId: string, onSelect = vi.fn()) {
  const anchorRef = createRef<HTMLElement>();
  render(
    <AddTabDropdown open={false} anchorRef={anchorRef} sessionId={sessionId} onClose={vi.fn()} onSelect={onSelect} />,
  );
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Map();
  m.ghosts = [];
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});
afterEach(cleanup);

it('offers the workbench in a local teammate main task and reopens it with the teammate id', () => {
  const onSelect = renderMenu('bot-main');
  fireEvent.click(screen.getByText('bots.workbench.title'));
  expect(m.open).toHaveBeenCalledWith('bot-main', 'bot-1');
  expect(onSelect).not.toHaveBeenCalled();
});

it('keeps the other entries on the generic add path', () => {
  const onSelect = renderMenu('bot-main');
  fireEvent.click(screen.getByText('rightSidebar.tabs.kinds.fileBrowser'));
  expect(onSelect).toHaveBeenCalledWith('file-browser');
  expect(m.open).not.toHaveBeenCalled();
});

it.each([
  ['an ordinary task', 'task-1'],
  ['a teammate history task', 'bot-history'],
])('does not offer the workbench in %s', (_label, sessionId) => {
  renderMenu(sessionId);
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
});

it.each([
  ['SSH remote', { remoteHostId: 'ssh-1' }],
  ['device-link', { deviceLinkDeviceId: 'device-2' }],
])('does not offer the workbench for a %s mirror', (_label, row) => {
  m.rows.set('bot-main', row);
  renderMenu('bot-main');
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
});

// 测试价值
// - 生产入口与可观察结果:「+」菜单插件项;可观察的是选择时把 (tabId, 此前是否已打开) 交给宿主,
//   独立窗口据此对「已打开」的页签切换 / 聚焦,而不是菜单关掉后毫无反应。
// - Bug / 规则依据:review「弹出窗口『+』菜单里已在别处打开的插件项点了没反应」。
// - 现有覆盖缺口:此前已打开的项不通知宿主。
// - 最小失败输入:同一个插件项连点两次。
it('reports whether a plugin tab already existed when its menu item is selected', () => {
  m.ghosts = [
    {
      manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html' } },
      enabled: true,
    },
  ];
  const onGlobalTabSelected = vi.fn();
  render(
    <AddTabDropdown
      open={false}
      anchorRef={createRef<HTMLElement>()}
      sessionId="task-1"
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(screen.getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', false);
  cleanup();
  render(
    <AddTabDropdown
      open={false}
      anchorRef={createRef<HTMLElement>()}
      sessionId="task-1"
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(screen.getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', true);
});

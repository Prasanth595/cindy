// @vitest-environment jsdom
import { createRef, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddTabDropdown } from '../AddTabDropdown';
import { EmptyState } from '../EmptyState';
import { FolderTree } from 'lucide-react';
import { useTabCreationMenu } from '../lib/useTabCreationMenu';
import { _resetTabKindRegistry, registerTabKind, unregisterTabKind } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';

const m = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  openSideChat: vi.fn(async () => true),
  canSideChat: false,
  rows: new Map<string, { remoteHostId?: string | null; deviceLinkDeviceId?: string | null; deviceLinkConnectionStatus?: string }>(),
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
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { subscribe: () => () => {}, findById: (id: string) => m.rows.get(id) ?? null } }));
vi.mock('../lib/openBotWorkbenchTab', () => ({ openBotWorkbenchTab: m.open }));
vi.mock('../lib/openSideChatTab', () => ({
  canOpenSideChat: () => m.canSideChat,
  openSideChatTab: m.openSideChat,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ useRemoteProjectSessions: () => [] }));

function registerMenu(kind: TabKindId, labelKey: string, order: number, extra: Partial<TabKindMenuMeta> = {}) {
  registerTabKind({ kind, menu: { kind, labelKey, order, icon: FolderTree, enabled: true, ...extra },
    TabBody: () => null, TabPillTitle: () => null, defaultState: () => null });
}

function Entries({ sessionId, onSelect, both = false, subagentsAvailable = false }: {
  sessionId: string; onSelect: (kind: TabKindId) => void; both?: boolean; subagentsAvailable?: boolean;
}) {
  const menu = useTabCreationMenu({ sessionId, subagentsAvailable, onSelect });
  return <>
    <div data-testid="menu"><AddTabDropdown open={false} anchorRef={createRef<HTMLElement>()}
      menu={menu} onClose={vi.fn()} /></div>
    {both && <div data-testid="empty"><EmptyState menu={menu} /></div>}
  </>;
}

function renderMenu(sessionId: string, onSelect = vi.fn()) {
  render(<Entries sessionId={sessionId} onSelect={onSelect} />);
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Map();
  m.canSideChat = false;
  _resetTabKindRegistry();
  registerMenu('file-browser', 'rightSidebar.tabs.kinds.fileBrowser', 20);
  registerMenu('review', 'rightSidebar.tabs.kinds.review', 10);
  registerMenu('bot-workbench', 'bots.workbench.title', 0);
  registerMenu('side-chat', 'chat.sideChat.new', 30);
  registerMenu('subagents', 'rightSidebar.tabs.kinds.subagents', 15);
});
afterEach(() => { cleanup(); _resetTabKindRegistry(); });

// Unit regression: the two entry surfaces drifted in labels, ordering and eligibility.
// Existing tests covered each separately. The same task with both real surfaces shows
// the mismatch; changing one registry entry must update both without another list edit.
it('shows identical action names and order in both entry surfaces', () => {
  const onSelect = vi.fn();
  render(<Entries sessionId="task-1" onSelect={onSelect} both />);
  const menu = within(screen.getByTestId('menu'));
  const empty = within(screen.getByTestId('empty'));
  const labels = (scope: typeof menu) => scope.getAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent);
  expect(labels(empty)).toEqual(labels(menu));
  expect(labels(empty)).toEqual(['rightSidebar.tabs.kinds.review', 'rightSidebar.tabs.kinds.fileBrowser']);
  act(() => registerMenu('web-browser', 'browser.translation', 5, {
    labelText: 'Browser',
    descriptionKey: 'Browse pages in the panel',
  }));
  expect(labels(empty)).toEqual(labels(menu));
  expect(labels(empty)[0]).toBe('Browser');
  expect(empty.getByRole('button', { name: 'Browser', description: 'Browse pages in the panel' })).toBeTruthy();
  expect(menu.queryByText('Browse pages in the panel')).toBeNull();
  fireEvent.click(empty.getByRole('button', { name: 'Browser' }));
  fireEvent.click(menu.getByRole('button', { name: 'Browser' }));
  expect(onSelect.mock.calls).toEqual([['web-browser'], ['web-browser']]);
  act(() => unregisterTabKind('web-browser'));
  expect(empty.queryByRole('button', { name: 'Browser' })).toBeNull();
  expect(labels(empty)).toEqual(labels(menu));
});

it('keeps side-chat pending state and offline restrictions consistent across both entries', async () => {
  m.canSideChat = true;
  let resolve!: (value: boolean) => void;
  m.openSideChat.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both />);
  const buttons = screen.getAllByRole('button', { name: 'chat.sideChat.new' });
  fireEvent.click(buttons[1]);
  expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  fireEvent.click(buttons[0]);
  expect(m.openSideChat).toHaveBeenCalledTimes(1);
  await act(async () => resolve(true));
  expect(buttons.every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  cleanup();
  m.rows.set('remote', { deviceLinkDeviceId: 'host', deviceLinkConnectionStatus: 'disconnected' });
  render(<Entries sessionId="remote" onSelect={vi.fn()} both />);
  expect(screen.getAllByRole('button', { name: 'chat.sideChat.new' })
    .every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});

it.each([false, true])('uses the same Subagent eligibility on both surfaces (available=%s)', subagentsAvailable => {
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both subagentsAvailable={subagentsAvailable} />);
  expect(screen.queryAllByRole('button', { name: 'rightSidebar.tabs.kinds.subagents' })).toHaveLength(subagentsAvailable ? 2 : 0);
});

it('keeps hidden and retired plugin panels out of both entry surfaces', () => {
  registerMenu('retired-feature', 'Retired', -2, { hiddenFromMenu: true });
  registerMenu('ghost:legacy', 'Legacy plugin', -1);
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both />);
  expect(screen.queryByRole('button', { name: 'Retired' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Legacy plugin' })).toBeNull();
});

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

// Unit regression: the missing menu entry must create a child task before opening its tab.
// The generic tab path only produces an empty sessionId, so the existing file/browser tests
// cannot cover this failure. Minimal input: an eligible parent and the new menu item.
it('opens a side chat through the task creator instead of creating an unbound empty tab', async () => {
  m.canSideChat = true;
  const onSelect = renderMenu('task-1');
  await act(async () => fireEvent.click(screen.getByText('chat.sideChat.new')));
  expect(m.openSideChat).toHaveBeenCalledExactlyOnceWith('task-1');
  expect(onSelect).not.toHaveBeenCalled();
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

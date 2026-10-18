// @vitest-environment jsdom
/**
 * 工作台的打开规则（伙伴自主跟进方案）：进入伙伴页不打开；「等你」从 0 变成 >0 时自动打开一次；
 * 主人关过的保持关着，只能从头部入口 / 「+」菜单重新打开。用真实的 BotSessionView、
 * useBotWorkbenchAutoOpen、glance 读取、右侧栏 store 与布局偏好；只隔离聊天面与宿主 IPC。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _resetStore, closeTab, getBucket } from '@/features/right-sidebar/store';
import { openBotWorkbenchTab } from '@/features/right-sidebar/lib/openBotWorkbenchTab';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { readPanelCollapsedRecord, writePanelCollapsed } from '@/layout/collapsePrefs';
import type { BotGlance } from '../../../../shared/botAutonomy';
import { BotSessionView } from '../BotSessionView';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ botId: 'bot', sessionId: 'chat' }),
  useNavigate: () => vi.fn(), Navigate: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useBotIslandVisibleSession', () => ({ useBotIslandVisibleSession: () => {} }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => <div>chat</div> }));
vi.mock('@/features/right-sidebar/lib/detachedSidebarRouting', () => ({ routeSidebarCommand: async () => 'attached' }));

const visibility = vi.fn();
const listTabs = vi.fn(async () => ({ tabs: [], activeTabId: null, persistable: false }));
const glance = vi.fn<(botId: string) => Promise<BotGlance>>();
let listeners: Array<(payload: { botIds?: string[] }) => void> = [];

function waitingCount(count: number): BotGlance {
  return {
    botId: 'bot', scope: 'own', working: [], lastSweepAt: 0, doneToday: 0, offlineDevices: [],
    waiting: Array.from({ length: count }, (_, i) => ({
      sessionId: `s${i}`, deviceId: null, deviceName: null, online: true, title: `t${i}`, kind: 'waiting' as const,
      minutes: 1, question: null, waitingFor: 'answer' as const, followerBotId: 'bot',
    })),
  };
}

/** 宿主推一次变化：工作台重读 glance，等这次读取落地。 */
async function hostChanged(next: BotGlance) {
  const before = glance.mock.calls.length;
  glance.mockResolvedValueOnce(next);
  await act(async () => { listeners.forEach((cb) => cb({ botIds: ['bot'] })); });
  expect(glance).toHaveBeenCalledTimes(before + 1);
  await act(async () => { await glance.mock.results.at(-1)!.value; });
}

beforeEach(() => {
  _resetStore(); _resetSidebarCommandsForTests(); localStorage.clear(); visibility.mockClear(); listTabs.mockClear();
  glance.mockReset(); listeners = [];
  onRequestRightSidebarVisibility(visibility);
  window.electronAPI = {
    localDb: {
      bots: {
        list: async () => [],
        get: async () => ({ id: 'bot', name: 'Cindy', status: 'active', sessions: [
          { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
        ] }),
        autonomy: { glance },
      },
      rightSidebarTabs: { list: listTabs },
    },
    maker: {
      onBotAutonomyChanged: (cb: (payload: { botIds?: string[] }) => void) => {
        listeners.push(cb);
        return () => { listeners = listeners.filter((item) => item !== cb); };
      },
    },
  } as unknown as Window['electronAPI'];
});
afterEach(() => { cleanup(); _resetStore(); _resetSidebarCommandsForTests(); });

it('does not open on the first visit, opens once when something starts waiting, and stays closed after the owner closes it', async () => {
  glance.mockResolvedValueOnce(waitingCount(0));
  const view = render(<BotSessionView />);
  await waitFor(() => expect(view.getByText('chat')).toBeTruthy());
  await waitFor(() => expect(glance).toHaveBeenCalledOnce());
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();

  await hostChanged(waitingCount(1));
  await waitFor(() => expect(getBucket('chat').tabs[0]?.kind).toBe('bot-workbench'));
  expect(visibility).toHaveBeenCalledOnce();

  // 还在等（1 → 2）不是新的 0 → >0，不再打扰。
  await hostChanged(waitingCount(2));
  expect(visibility).toHaveBeenCalledOnce();

  await act(async () => { await closeTab('chat', getBucket('chat').tabs[0]!.id); });
  writePanelCollapsed('right-tabs', { sessionId: 'chat' }, true);
  visibility.mockClear();
  await hostChanged(waitingCount(0));
  await hostChanged(waitingCount(1));
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();

  // 关过的只能显式重新打开。
  await act(async () => { await openBotWorkbenchTab('chat', 'bot'); });
  expect(getBucket('chat').tabs[0]?.kind).toBe('bot-workbench');
  expect(visibility).toHaveBeenCalledOnce();
});

it('keeps a closed workbench closed through remount even when something is already waiting', async () => {
  writePanelCollapsed('right-tabs', { sessionId: 'chat' }, true);
  glance.mockResolvedValue(waitingCount(1));
  const view = render(<BotSessionView />);
  await waitFor(() => expect(glance).toHaveBeenCalled());
  await waitFor(() => expect(view.getByText('chat')).toBeTruthy());
  await act(async () => { await Promise.resolve(); });
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();
  expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'chat' })).toBe(true);
});

it('unmounting the Bot view cancels a late automatic open', async () => {
  let release!: () => void;
  listTabs.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { tabs: [], activeTabId: null, persistable: false };
  });
  glance.mockResolvedValue(waitingCount(1));
  const view = render(<BotSessionView />);
  await waitFor(() => expect(listTabs).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => { release(); });
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();
  expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'chat' })).toBeNull();
});

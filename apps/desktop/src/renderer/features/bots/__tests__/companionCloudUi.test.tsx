// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  ensureLoaded: vi.fn(async () => []),
  devices: [{ deviceId: 'tablet', name: 'Tablet', isSelf: false }],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('../BotSessionContentHeader', () => ({ BotSessionContentHeaderRegistration: () => null }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span /> }));
vi.mock('../botStore', () => ({ ensureBotProfilesLoaded: h.ensureLoaded }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => h.devices }));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toast, error: h.toast } }));

import { CloudCompanionOfflineView } from '../CloudCompanionOfflineView';
import { BotHomeComputerSetting } from '../BotHomeComputerSetting';
import { resetCompanionCloudStoreForTests, useCompanionCloud } from '../companionCloudStore';
import { cloudOnlyRemoteBots, cloudRemoteBots, isCloudHomeOffline, withoutShadowedBots } from '../companionCloudPresentation';
import { BotConnectionStatus } from '../BotConnectionStatus';

const maker = {
  getCompanionCloudState: vi.fn(),
  onCompanionCloudChanged: vi.fn(() => () => undefined),
  getCompanionTranscript: vi.fn(),
  takeOverCompanion: vi.fn(),
  listCompanionTransferTargets: vi.fn(),
  transferCompanion: vi.fn(),
};

const snapshot = (home: string | null, enabled = true): CompanionCloudSnapshot => ({
  enabled, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [{ id: 'a-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: home,
    homeDevice: home ? { deviceId: home, name: home === 'desk' ? 'Desk' : 'Laptop', online: false, isSelf: home === 'desk' } : null }],
});

beforeEach(() => {
  for (const fn of Object.values(maker)) fn.mockReset();
  maker.onCompanionCloudChanged.mockImplementation(() => () => undefined);
  h.navigate.mockReset();
  h.toast.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { maker } });
});
afterEach(() => { cleanup(); });

describe('presentation helpers', () => {
  it('hides demoted copies and adds unseen cloud homes as offline rows', () => {
    const cloud = { ...snapshot('laptop'), demotedBotIds: ['mia'] };
    expect(withoutShadowedBots([{ id: 'mia' }, { id: 'ada' }], cloud)).toEqual([{ id: 'ada' }]);
    // Persisted demotion holds with the feature off or the server unreachable.
    expect(withoutShadowedBots([{ id: 'mia' }], { ...cloud, enabled: false })).toEqual([]);
    const extra = cloudOnlyRemoteBots(cloud, []);
    expect(extra).toMatchObject([{ id: 'mia', deviceId: 'laptop', deviceName: 'Laptop', online: false }]);
    expect(cloudOnlyRemoteBots(cloud, extra)).toEqual([]);
    expect(isCloudHomeOffline(cloud, extra[0])).toBe(true);
    expect(isCloudHomeOffline(cloud, { ...extra[0]!, online: true })).toBe(false);
    expect(isCloudHomeOffline(snapshot('desk'), { id: 'mia', deviceId: 'desk', online: false })).toBe(false);
  });

  it('lists a companion once, on its main computer, dropping old computers\' cached copies', () => {
    const row = (deviceId: string, id = 'mia') => ({ id, deviceId, deviceName: deviceId, name: id, avatar: '', avatarColor: 'violet',
      description: '', preview: '', activityAt: 0, sessionId: null, online: false, connectionKnown: true }) as const;
    // The old computer is offline and only its cached row is left: replaced by the main computer's row.
    expect(cloudRemoteBots(snapshot('laptop'), [row('old-mac'), row('old-mac', 'ada')]).map((bot) => `${bot.deviceId}/${bot.id}`))
      .toEqual(['old-mac/ada', 'laptop/mia']);
    expect(cloudRemoteBots(snapshot('laptop'), [row('old-mac'), row('laptop')]).map((bot) => bot.deviceId)).toEqual(['laptop']);
    // Homed here: other computers' copies are not separate entries.
    expect(cloudRemoteBots(snapshot('desk'), [row('old-mac')])).toEqual([]);
    expect(cloudRemoteBots(snapshot('laptop', false), [row('old-mac')])).toHaveLength(1);
  });

  it('labels an offline main computer in the row status', () => {
    render(<BotConnectionStatus inline online={false} homeOffline deviceName="Laptop" />);
    expect(screen.getByText('bots.cloud.homeOfflineShort · Laptop')).toBeTruthy();
  });
});

describe('CloudCompanionOfflineView', () => {
  const page = { messages: [
    { id: 'm1', seq: '1', role: 'user', text: 'hello', createdAt: 1 },
    { id: 'm2', seq: '2', role: 'assistant', text: 'hi there', createdAt: 2 },
  ] };
  const renderView = () => render(<CloudCompanionOfflineView botId="mia" deviceId="laptop" name="Mia" deviceName="Laptop" />);

  it('shows the banner and the read-only cloud conversation, oldest first', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    renderView();
    expect(screen.getByText('bots.cloud.homeOffline:{"device":"Laptop"}')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('hi there')).toBeTruthy());
    const texts = [...document.querySelectorAll('article')].map((node) => node.textContent);
    expect(texts).toEqual(['hello', 'hi there']);
    expect(maker.getCompanionTranscript).toHaveBeenCalledWith('mia', undefined);
    expect(screen.getByText('bots.cloud.readOnlyNote')).toBeTruthy();
  });

  it('loads older messages on request', async () => {
    maker.getCompanionTranscript.mockResolvedValueOnce({ ...page, nextBefore: '1' })
      .mockResolvedValueOnce({ messages: [{ id: 'm0', seq: '0', role: 'user', text: 'earlier', createdAt: 0 }] });
    renderView();
    await waitFor(() => expect(screen.getByText('bots.cloud.loadOlder')).toBeTruthy());
    fireEvent.click(screen.getByText('bots.cloud.loadOlder'));
    await waitFor(() => expect(screen.getByText('earlier')).toBeTruthy());
    expect(maker.getCompanionTranscript).toHaveBeenLastCalledWith('mia', '1');
    expect([...document.querySelectorAll('article')].map((node) => node.textContent)).toEqual(['earlier', 'hello', 'hi there']);
  });

  it('continues on this computer and opens the local companion', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    let finish!: (value: unknown) => void;
    maker.takeOverCompanion.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(screen.getByText('bots.cloud.takingOver:{"name":"Mia"}')).toBeTruthy());
    await act(async () => { finish({ ok: true }); });
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
    expect(maker.takeOverCompanion).toHaveBeenCalledWith('mia');
    expect(h.ensureLoaded).toHaveBeenCalledWith(true);
  });

  it('follows the companion when another computer already continued', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'HOME_CONFLICT', homeDeviceId: 'tablet' });
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/tablet/mia'));
    expect(h.toast).toHaveBeenCalledWith('bots.cloud.takeOverConflict:{"name":"Mia","device":"Tablet"}');
  });

  it('explains a failed take-over inline and lets the user try again', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValueOnce({ ok: false, code: 'OFFLINE' }).mockResolvedValueOnce({ ok: true });
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(screen.getByText('bots.cloud.takeOverOffline:{"name":"Mia"}')).toBeTruthy());
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
  });
});

describe('BotHomeComputerSetting', () => {
  const bot = { id: 'mia', name: 'Mia' };
  const openMenu = () => fireEvent.keyDown(screen.getByTestId('bot-home-computer-row'), { key: 'ArrowDown' });

  it.each([
    ['the feature is off', snapshot('desk', false)],
    ['the home is another computer', snapshot('laptop')],
  ])('is hidden when %s', (_name, cloud) => {
    resetCompanionCloudStoreForTests(cloud);
    maker.getCompanionCloudState.mockResolvedValue(cloud);
    render(<BotHomeComputerSetting bot={bot} />);
    expect(screen.queryByTestId('bot-home-computer-row')).toBeNull();
  });

  it('confirms before moving the companion, then opens it on the new computer', async () => {
    resetCompanionCloudStoreForTests(snapshot('desk'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('desk'));
    maker.listCompanionTransferTargets.mockResolvedValue([{ deviceId: 'laptop', name: 'Laptop', online: true }]);
    maker.transferCompanion.mockResolvedValue({ ok: true });
    render(<BotHomeComputerSetting bot={bot} />);
    expect(screen.getByText('bots.cloud.thisComputer')).toBeTruthy();
    openMenu();
    const item = await screen.findByText('bots.cloud.moveTo:{"device":"Laptop"}');
    fireEvent.click(item);
    await screen.findByText('bots.cloud.transferDescription:{"name":"Mia","device":"Laptop"}');
    expect(maker.transferCompanion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.transferAction:{"device":"Laptop"}' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia'));
    expect(maker.transferCompanion).toHaveBeenCalledWith('mia', 'laptop');
  });

  it('shows why a move did not happen', async () => {
    resetCompanionCloudStoreForTests(snapshot('desk'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('desk'));
    maker.listCompanionTransferTargets.mockResolvedValue([{ deviceId: 'laptop', name: 'Laptop', online: true }]);
    maker.transferCompanion.mockResolvedValue({ ok: false, code: 'OFFLINE' });
    render(<BotHomeComputerSetting bot={bot} />);
    openMenu();
    fireEvent.click(await screen.findByText('bots.cloud.moveTo:{"device":"Laptop"}'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.transferAction:{"device":"Laptop"}' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.cloud.transferOffline:{"name":"Mia","device":"Laptop"}');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('asks to resume a paused companion before moving it', async () => {
    resetCompanionCloudStoreForTests(snapshot('desk'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('desk'));
    render(<BotHomeComputerSetting bot={{ ...bot, status: 'paused' }} />);
    openMenu();
    expect(await screen.findByText('bots.cloud.resumeToMove:{"name":"Mia"}')).toBeTruthy();
    expect(maker.listCompanionTransferTargets).not.toHaveBeenCalled();
  });

  it('says when no other computer can take over', async () => {
    resetCompanionCloudStoreForTests(snapshot('desk'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('desk'));
    maker.listCompanionTransferTargets.mockResolvedValue([]);
    render(<BotHomeComputerSetting bot={bot} />);
    openMenu();
    expect(await screen.findByText('bots.cloud.noTargets')).toBeTruthy();
  });
});

describe('companionCloudStore', () => {
  it('keeps a newer push when an older refresh answers later', async () => {
    const { renderHook } = await import('@testing-library/react');
    resetCompanionCloudStoreForTests(snapshot('desk'));
    let answer: (value: CompanionCloudSnapshot) => void = () => undefined;
    maker.getCompanionCloudState.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    let push: (next: CompanionCloudSnapshot) => void = () => undefined;
    maker.onCompanionCloudChanged.mockImplementation(((listener: typeof push) => { push = listener; return () => undefined; }) as never);
    const { result, unmount } = renderHook(() => useCompanionCloud());
    await waitFor(() => expect(maker.getCompanionCloudState).toHaveBeenCalled());
    act(() => push(snapshot('laptop')));
    await act(async () => { answer(snapshot('desk')); await Promise.resolve(); });
    expect(result.current.actors[0]!.homeDeviceId).toBe('laptop');
    unmount();
  });
});

describe('CompanionShadowBanner', () => {
  it('opens the companion on its main computer or takes it over here', async () => {
    const { CompanionShadowBanner } = await import('../CompanionShadowBanner');
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.takeOverCompanion.mockResolvedValue({ ok: true });
    render(<CompanionShadowBanner botId="mia" name="Mia" />);
    expect(screen.getByText('bots.cloud.shadowTitle:{"device":"Laptop"}')).toBeTruthy();
    fireEvent.click(screen.getByText('bots.cloud.openOnHome:{"device":"Laptop"}'));
    expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia');
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(maker.takeOverCompanion).toHaveBeenCalledWith('mia'));
    await waitFor(() => expect(h.ensureLoaded).toHaveBeenCalledWith(true));
  });
});

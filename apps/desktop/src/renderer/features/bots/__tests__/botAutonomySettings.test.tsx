// @vitest-environment jsdom
/**
 * 「自动跟进所有任务」设置：账号里只有一位伙伴负责（默认出厂 Cindy 助理）。真实的
 * BotAutonomySettings + botStore 里的自动跟进设置存储；宿主用一个按 override 语义工作的假
 * IPC 代替（set = 写 override，reset = 删 override，变化推 onBotAutonomyChanged）。
 * 依据：伙伴自主跟进方案的设置合同——打开即移走、提示「已从 X 移到这里」、关闭要确认、
 * 只在改过时给「恢复默认」、别的窗口改了也跟着变。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BotAutonomySettingsView } from '../../../../shared/botAutonomy';

const m = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toastError: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).map(String).join(',')}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: m.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: m.toastError } }));
vi.mock('../botStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../botStore')>()),
  useBotProfiles: () => [
    { id: 'cindy-default', name: 'Cindy' },
    { id: 'bot-b', name: 'Bea' },
  ],
}));

import { BotAutonomySettings } from '../BotAutonomySettings';

const DEFAULTS = { schedulerBotId: 'cindy-default' };
let override: string | null | undefined;
let listeners: Array<(payload: { botIds?: string[] }) => void> = [];
const host = {
  getSettings: vi.fn(async (): Promise<BotAutonomySettingsView> => view()),
  setSettings: vi.fn(async (patch: { schedulerBotId: string | null }) => {
    override = patch.schedulerBotId;
    return view();
  }),
  resetSettings: vi.fn(async () => {
    override = undefined;
    return view();
  }),
};

function view(): BotAutonomySettingsView {
  return {
    schedulerBotId: override === undefined ? DEFAULTS.schedulerBotId : override,
    isCustomized: override !== undefined,
    defaults: DEFAULTS,
  };
}

function settingsFor(botId: string, onAllow = vi.fn()) {
  return (
    <div data-testid={botId}>
      <BotAutonomySettings
        botId={botId}
        botName={botId === 'bot-b' ? 'Bea' : 'Cindy'}
        allowSchedulerFollow={false}
        onAllowSchedulerFollowChange={onAllow}
      />
    </div>
  );
}

const mainSwitch = (botId: string) =>
  within(screen.getByTestId(botId)).getByRole('switch', { name: 'bots.autonomy.title' });

beforeEach(() => {
  vi.clearAllMocks();
  override = undefined;
  listeners = [];
  m.confirm.mockResolvedValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { autonomy: host } },
    maker: {
      onBotAutonomyChanged: (cb: (payload: { botIds?: string[] }) => void) => {
        listeners.push(cb);
        return () => { listeners = listeners.filter((item) => item !== cb); };
      },
    },
  };
});
afterEach(() => cleanup());

it('moves follow-up to this teammate, tells where it came from, and turns the previous one off', async () => {
  const onAllow = vi.fn();
  render(<>{settingsFor('cindy-default')}{settingsFor('bot-b', onAllow)}</>);
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true'));
  const bea = within(screen.getByTestId('bot-b'));
  expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('false');
  expect(bea.getByText('bots.autonomy.heldBy:Cindy')).toBeTruthy();
  expect(screen.queryByText(/bots.autonomy.restoreDefault/)).toBeNull();
  // 别的伙伴才有「它开的任务也交给 Cindy 跟进」；负责的伙伴自己没有。
  fireEvent.click(bea.getByRole('switch', { name: 'bots.autonomy.allowSchedulerFollow.title:Cindy' }));
  expect(onAllow).toHaveBeenCalledWith(true);
  expect(within(screen.getByTestId('cindy-default')).queryByRole('switch', { name: /allowSchedulerFollow/ })).toBeNull();

  fireEvent.click(mainSwitch('bot-b'));
  await waitFor(() => expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('true'));
  expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: 'bot-b' });
  expect(bea.getByText('bots.autonomy.movedFrom:Cindy')).toBeTruthy();
  expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false');
  expect(bea.queryByRole('switch', { name: /allowSchedulerFollow/ })).toBeNull();

  // 改过才有恢复默认；恢复 = 删除 override，回到 Cindy。
  fireEvent.click(bea.getByRole('button', { name: 'bots.autonomy.restoreDefault:Cindy' }));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true'));
  expect(host.resetSettings).toHaveBeenCalledOnce();
  expect(screen.queryByText(/bots.autonomy.restoreDefault/)).toBeNull();
});

it('asks before turning it off and leaves nobody in charge only when confirmed', async () => {
  render(settingsFor('cindy-default'));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true'));

  m.confirm.mockResolvedValueOnce(false);
  fireEvent.click(mainSwitch('cindy-default'));
  await waitFor(() => expect(m.confirm).toHaveBeenCalledOnce());
  expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'bots.autonomy.turnOff.description' }));
  expect(host.setSettings).not.toHaveBeenCalled();
  expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true');

  fireEvent.click(mainSwitch('cindy-default'));
  await waitFor(() => expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: null }));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false'));
  expect(screen.getByText('bots.autonomy.heldByNobody')).toBeTruthy();
});

it('follows a change made elsewhere (another window or the agent) through the host push', async () => {
  render(settingsFor('bot-b'));
  await waitFor(() => expect(screen.getByText('bots.autonomy.heldBy:Cindy')).toBeTruthy());
  override = 'bot-b';
  await act(async () => { listeners.forEach((cb) => cb({})); });
  await waitFor(() => expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('true'));
  // 不是在这里打开的，不显示「已从…移到这里」。
  expect(screen.queryByText(/bots.autonomy.movedFrom/)).toBeNull();
});

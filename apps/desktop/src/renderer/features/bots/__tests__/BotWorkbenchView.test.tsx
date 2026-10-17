// @vitest-environment jsdom
/**
 * 工作台「一眼」：真实的 BotWorkbench + botGlance（读取、订阅、按电脑改写、允许），只隔离宿主
 * IPC、设备清单、路由与 toast。依据：伙伴自主跟进方案的工作台合同——两块（等你 / 在做）+ 一行
 * 页脚 + 两块都空时的安静状态；「允许」只回应那一行的那条权限请求，请求不在了改为打开任务，
 * 别的电脑离线时不能替主人操作。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BotGlance, GlanceRow } from '../../../../shared/botAutonomy';

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  remoteApi: { getPendingInteractions: vi.fn(), resolveInteraction: vi.fn() },
  makerApiForDevice: vi.fn(),
  resolveRoute: vi.fn(async (id: string) => `/cc-agent/${id}`),
  pinSessionOrigin: vi.fn(),
  mirrored: [] as Array<{ id: string }>,
  devices: [] as Array<Record<string, unknown>>,
}));

function deviceList(studio: Record<string, unknown> = {}) {
  const controllable = { online: true, remoteControlEnabled: true, controlEnabled: true };
  return [
    { deviceId: 'dev-self', name: 'MacBook', isSelf: true, ...controllable },
    { deviceId: 'dev-2', name: 'Studio', isSelf: false, ...controllable, ...studio },
  ];
}
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).map(String).join(',')}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => m.devices,
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: m.resolveRoute }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { pinSessionOrigin: m.pinSessionOrigin, getMergedRemoteSessions: () => m.mirrored },
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: m.toastWarning, error: m.toastError } }));
vi.mock('@/lib/makerTransport', () => ({ makerApiForDevice: m.makerApiForDevice }));

import { BotWorkbench } from '../BotWorkbench';
import { allowGlanceRow } from '../botGlance';

type Listener = (payload: { botIds?: string[] }) => void;
let listeners: Listener[] = [];
const glanceApi = vi.fn<(botId: string) => Promise<BotGlance>>();
const localMaker = { getPendingInteractions: vi.fn(), resolveInteraction: vi.fn() };
const remoteInvoke = vi.fn();

function row(patch: Partial<GlanceRow>): GlanceRow {
  return {
    sessionId: 's1',
    deviceId: null,
    deviceName: null,
    online: true,
    title: '修登录超时',
    kind: 'waiting',
    minutes: 12,
    question: null,
    waitingFor: null,
    followerBotId: 'bot-1',
    ...patch,
  };
}

function glance(patch: Partial<BotGlance> = {}): BotGlance {
  return { botId: 'bot-1', scope: 'own', waiting: [], working: [], lastSweepAt: Date.now(), doneToday: 0, offlineDevices: [], ...patch };
}

function permission(requestId: string) {
  return { request: { kind: 'permission', requestId } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners = [];
  m.makerApiForDevice.mockReturnValue(m.remoteApi);
  m.mirrored = [];
  m.devices = deviceList();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { autonomy: { glance: glanceApi } } },
    maker: {
      ...localMaker,
      onBotAutonomyChanged: (cb: Listener) => {
        listeners.push(cb);
        return () => { listeners = listeners.filter((item) => item !== cb); };
      },
    },
    deviceLink: {
      invoke: remoteInvoke,
      onRemotePush: () => () => undefined,
    },
  };
});

afterEach(() => cleanup());

it('shows one quiet sentence when nothing waits or runs, and the follow-everything tag for the scheduler', async () => {
  glanceApi.mockResolvedValue(glance({ scope: 'all', doneToday: 3, offlineDevices: ['Studio'] }));
  render(<BotWorkbench botId="bot-1" />);

  expect(await screen.findByText('bots.workbench.glance.quiet')).toBeTruthy();
  expect(screen.getByText('bots.autonomy.title')).toBeTruthy();
  expect(screen.queryByRole('heading')).toBeNull();
  const footerText = screen.getByText(
    'bots.workbench.glance.seenJust · bots.workbench.glance.doneToday:3 · bots.workbench.glance.devicesOffline:Studio',
  );
  // 页脚不跟两块一起滚：它是面板的直接子节点，与滚动的内容区并列（实测 800 高窗口里页脚曾被挤到折叠线下）。
  const panel = screen.getByRole('region', { name: 'bots.workbench.title' });
  const footer = footerText.closest('footer')!;
  expect(footer.parentElement).toBe(panel);
  expect(footer.previousElementSibling?.contains(screen.getByText('bots.workbench.glance.quiet'))).toBe(true);
});

it('allows only the permission request the row points at, and opens the task when that request is gone', async () => {
  glanceApi.mockResolvedValue(glance({
    waiting: [row({ sessionId: 's1', question: '要删掉旧迁移吗？', waitingFor: 'permission', requestId: 'r-2' })],
    working: [row({ sessionId: 's2', title: '跑测试', kind: 'working', minutes: 5 })],
  }));
  localMaker.getPendingInteractions.mockResolvedValue([permission('r-1'), permission('r-2')]);
  localMaker.resolveInteraction.mockResolvedValue({ accepted: true });
  render(<BotWorkbench botId="bot-1" />);

  const waiting = (await screen.findByText('要删掉旧迁移吗？')).closest('li')!;
  expect(within(waiting).getByText(/修登录超时 · bots.workbench.glance.waitedFor/)).toBeTruthy();
  expect(screen.getByText('跑测试')).toBeTruthy();
  fireEvent.click(within(waiting).getByRole('button', { name: 'bots.workbench.glance.allow' }));
  await waitFor(() => expect(localMaker.resolveInteraction).toHaveBeenCalledTimes(1));
  expect(localMaker.getPendingInteractions).toHaveBeenCalledWith('s1');
  expect(localMaker.resolveInteraction).toHaveBeenCalledWith('r-2', { kind: 'permission', behavior: 'allow' });
  expect(m.navigate).not.toHaveBeenCalled();

  // 同一行的请求已被处理或换掉：不替主人批准别的请求，改为打开那件任务。
  localMaker.getPendingInteractions.mockResolvedValue([permission('r-9')]);
  fireEvent.click(within(waiting).getByRole('button', { name: 'bots.workbench.glance.allow' }));
  await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/cc-agent/s1'));
  expect(localMaker.resolveInteraction).toHaveBeenCalledTimes(1);
});

it('opens a task on another computer through the device-aware route, not a same-id local lookup', async () => {
  glanceApi.mockResolvedValue(glance({
    waiting: [
      row({ sessionId: 'dev-2::s7', deviceId: 'dev-2', deviceName: 'Studio', question: '用哪个分支？', waitingFor: 'answer' }),
      row({ sessionId: 'dev-3::s8', deviceId: 'dev-3', deviceName: 'Mini', online: false, question: '可以推送吗？', waitingFor: 'permission', requestId: 'r-8' }),
    ],
    working: [row({ sessionId: 'dev-3::s9', deviceId: 'dev-3', deviceName: 'Mini', online: false, title: '整理日志', kind: 'working' })],
  }));
  render(<BotWorkbench botId="bot-1" />);

  const answer = (await screen.findByText('用哪个分支？')).closest('li')!;
  expect(within(answer).queryByRole('button', { name: 'bots.workbench.glance.allow' })).toBeNull();
  m.mirrored = [{ id: 's7' }];
  fireEvent.click(within(answer).getByRole('button', { name: 'bots.workbench.glance.answer' }));
  await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/cc-agent/s7'));
  // 先登记这件任务属于 Studio，再按远程镜像里的那一行解析——与会话链接打开远程任务同一路径。
  expect(m.pinSessionOrigin).toHaveBeenCalledWith('dev-2', 's7');
  expect(m.resolveRoute).toHaveBeenCalledWith('s7', { id: 's7' });
  expect(m.pinSessionOrigin.mock.invocationCallOrder[0]).toBeLessThan(m.resolveRoute.mock.invocationCallOrder[0]!);

  const offline = screen.getByText('可以推送吗？').closest('li')!;
  expect((within(offline).getByRole('button', { name: 'bots.workbench.glance.allow' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('bots.workbench.glance.deviceOffline:Mini')).toBeTruthy();
  expect(m.makerApiForDevice).not.toHaveBeenCalled();
});

it('re-reads only on changes for this teammate', async () => {
  glanceApi.mockResolvedValueOnce(glance()).mockResolvedValueOnce(glance({ waiting: [row({ question: '新问题' })] }));
  render(<BotWorkbench botId="bot-1" />);
  await screen.findByText('bots.workbench.glance.quiet');

  act(() => listeners.forEach((cb) => cb({ botIds: ['bot-2'] })));
  expect(glanceApi).toHaveBeenCalledTimes(1);
  act(() => listeners.forEach((cb) => cb({ botIds: ['bot-1'] })));
  expect(await screen.findByText('新问题')).toBeTruthy();
});

it('reads a teammate on another computer from that computer and answers its own tasks through it', async () => {
  remoteInvoke.mockResolvedValue(glance({
    waiting: [row({ sessionId: 's5', question: '覆盖配置吗？', waitingFor: 'permission', requestId: 'r-5' })],
  }));
  m.remoteApi.getPendingInteractions.mockResolvedValue([permission('r-5')]);
  m.remoteApi.resolveInteraction.mockResolvedValue({ accepted: true });
  render(<BotWorkbench botId="bot-1" hostDeviceId="dev-2" />);

  const waiting = (await screen.findByText('覆盖配置吗？')).closest('li')!;
  expect(remoteInvoke).toHaveBeenCalledWith('dev-2', 'local-db:bots:autonomy:glance', ['bot-1']);
  expect(glanceApi).not.toHaveBeenCalled();
  // 那台的本机任务从这台看就是 Studio 上的任务。
  expect(within(waiting).getByText(/Studio/)).toBeTruthy();
  fireEvent.click(within(waiting).getByRole('button', { name: 'bots.workbench.glance.allow' }));
  await waitFor(() => expect(m.remoteApi.resolveInteraction).toHaveBeenCalledWith('r-5', { kind: 'permission', behavior: 'allow' }));
  expect(m.makerApiForDevice).toHaveBeenCalledWith('dev-2');
  expect(m.remoteApi.getPendingInteractions).toHaveBeenCalledWith('s5');
});

// 依据：工作台合同「别的电脑离线时不能替主人操作」；缺口：读过一次后那台断开，保留的旧内容仍显示在线、
// 「允许」可点。最小失败输入：首读成功、变化推送后的重读失败。tier：renderer unit。
it('greys out a remote teammate\'s rows once that computer stops answering, keeping the last content', async () => {
  let push: ((event: unknown, stamp: unknown) => void) | undefined;
  (window as unknown as { electronAPI: { deviceLink: { onRemotePush: unknown } } }).electronAPI.deviceLink.onRemotePush =
    (cb: (event: unknown, stamp: unknown) => void) => { push = cb; return () => undefined; };
  remoteInvoke.mockResolvedValueOnce(glance({
    waiting: [row({ sessionId: 's7', question: '删掉旧分支吗？', waitingFor: 'permission', requestId: 'r-7' })],
  }));
  render(<BotWorkbench botId="bot-1" hostDeviceId="dev-2" />);
  const allow = () => within(screen.getByText('删掉旧分支吗？').closest('li')!)
    .getByRole('button', { name: 'bots.workbench.glance.allow' }) as HTMLButtonElement;
  await screen.findByText('删掉旧分支吗？');
  expect(allow().disabled).toBe(false);

  remoteInvoke.mockRejectedValueOnce(new Error('offline'));
  act(() => push?.({ deviceId: 'dev-2', channel: 'maker:bot-autonomy:changed', payload: { botIds: ['bot-1'] } }, {}));
  await waitFor(() => expect(allow().disabled).toBe(true));
  expect(screen.getByText('删掉旧分支吗？')).toBeTruthy();
});

it('greys out a remote teammate\'s rows when remote control to that computer is turned off', async () => {
  remoteInvoke.mockResolvedValue(glance({
    waiting: [row({ sessionId: 's8', question: '合并到主干吗？', waitingFor: 'permission', requestId: 'r-8' })],
  }));
  const view = render(<BotWorkbench botId="bot-1" hostDeviceId="dev-2" />);
  const allow = () => within(screen.getByText('合并到主干吗？').closest('li')!)
    .getByRole('button', { name: 'bots.workbench.glance.allow' }) as HTMLButtonElement;
  await screen.findByText('合并到主干吗？');
  expect(allow().disabled).toBe(false);

  m.devices = deviceList({ controlEnabled: false });
  view.rerender(<BotWorkbench botId="bot-1" hostDeviceId="dev-2" />);
  expect(allow().disabled).toBe(true);
});

it('never approves a confirmation that carries no request id; it opens the task instead', async () => {
  // 宿主把 kind 含 confirm 的交互归成权限类但没有 requestId：那件任务里唯一的权限请求不一定是这一行。
  const confirmRow = row({ sessionId: 's3', question: '确认要发布吗？', waitingFor: 'permission', requestId: null });
  glanceApi.mockResolvedValue(glance({ waiting: [confirmRow] }));
  localMaker.getPendingInteractions.mockResolvedValue([permission('r-other')]);
  render(<BotWorkbench botId="bot-1" />);

  const waiting = (await screen.findByText('确认要发布吗？')).closest('li')!;
  expect(within(waiting).queryByRole('button', { name: 'bots.workbench.glance.allow' })).toBeNull();
  fireEvent.click(within(waiting).getByRole('button', { name: 'bots.workbench.glance.look' }));
  await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('/cc-agent/s3'));
  expect(m.pinSessionOrigin).not.toHaveBeenCalled();
  await expect(allowGlanceRow(confirmRow)).resolves.toBe('gone');
  expect(localMaker.getPendingInteractions).not.toHaveBeenCalled();
  expect(localMaker.resolveInteraction).not.toHaveBeenCalled();
});

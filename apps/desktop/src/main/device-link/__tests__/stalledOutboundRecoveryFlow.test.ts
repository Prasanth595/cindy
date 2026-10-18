/**
 * 出站链路主动重开的完整流程(真实 DeviceLinkClient × 2 + 内存 relay)。
 *
 * 接线与 index.ts 相同:transport-timeout 重开循环 + stalledOutboundRecovery +
 * attachStalledOutboundRecovery,openRemoteLink 用同设备在途复用。
 * 钉住三件事:
 *  1. 虚拟机暂停/恢复后,没有 presence 上线通知也能由本机重开;
 *  2. 不会重复建链:多个恢复事件、用户手动打开同时发生时,对端只收到一次 link-open;
 *  3. 旧状态清理干净:恢复、用户断开、对端永久关闭之后,不会有迟到的定时器再建链;
 *     本机 relay 断线不算「不再需要」,重新上线后接着重开;
 *  4. 故障半径:同一 relay 上的健康 peer 在故障 peer 多轮重开期间零感知。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceLinkClient,
  PROTOCOL_VERSION,
  type Envelope,
} from '@cindy/device-link';
import { isPermanentReopenError, shouldRecoverStalledOutboundLink } from '../linkRecovery';
import {
  createTransportTimeoutReopenLoop,
  routeLinkCloseForReopen,
  shouldAbortTransportTimeoutReopen,
} from '../transportTimeoutReopen';
import {
  attachStalledOutboundRecovery,
  createStalledOutboundRecovery,
} from '../stalledOutboundRecovery';

type Handler = (...args: never[]) => void;

class FlowWs {
  readonly bufferedAmount = 0;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(private readonly relay: FlowRelay, readonly ownerId: string) {}

  send(data: string): void {
    this.relay.route(this.ownerId, this, JSON.parse(data) as Envelope);
  }

  close(code = 1000, reason = ''): void {
    this.emit('close', code, reason);
  }

  terminate(): void {
    this.emit('close', 1006, 'terminated');
  }

  on(event: string, cb: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }

  push(envelope: Envelope): void {
    this.emit('message', { toString: () => JSON.stringify(envelope) });
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...(args as never[]));
  }
}

/** 最小 relay:按目的地转发;`offline` 里的设备收不到帧,发送方收到 DEVICE_OFFLINE。 */
class FlowRelay {
  private readonly sockets = new Map<string, FlowWs>();
  readonly offline = new Set<string>();
  /** 每个目的地实际送达的 link-open 次数。 */
  readonly deliveredLinkOpens = new Map<string, number>();
  /** 丢弃匹配的帧(模拟对端恢复后不主动发任何恢复信号)。 */
  drop: ((senderId: string, envelope: Envelope) => boolean) | null = null;
  /** 关闭了「允许远程控制」的设备:对它的帧返回 REMOTE_DISABLED。 */
  readonly remoteDisabled = new Set<string>();
  /** 连不上 relay 的设备:新连接立刻被关闭,对它的帧按离线处理。 */
  readonly unreachable = new Set<string>();

  makeWebSocket(deviceId: string): FlowWs {
    const socket = new FlowWs(this, deviceId);
    this.sockets.set(deviceId, socket);
    setTimeout(() => {
      if (this.unreachable.has(deviceId)) socket.emit('close', 1006, 'relay unreachable');
      else socket.emit('open');
    }, 0);
    return socket;
  }

  /** 断开某台设备到 relay 的连接(它的 client 会自己重连)。 */
  disconnect(deviceId: string): void {
    this.sockets.get(deviceId)?.emit('close', 1006, 'dropped');
  }

  route(senderId: string, socket: FlowWs, envelope: Envelope): void {
    if (envelope.kind === 'hello') {
      socket.push({
        v: PROTOCOL_VERSION,
        kind: 'hello-ack',
        payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: senderId, userId: 'test-user' },
      });
      return;
    }
    if (!envelope.dst) return;
    if (this.remoteDisabled.has(envelope.dst)) {
      socket.push({
        v: PROTOCOL_VERSION,
        kind: 'relay-error',
        ...(envelope.id ? { id: envelope.id } : {}),
        payload: { code: 'REMOTE_DISABLED', message: 'remote control disabled', dst: envelope.dst },
      });
      return;
    }
    if (this.offline.has(envelope.dst) || this.unreachable.has(envelope.dst)) {
      socket.push({
        v: PROTOCOL_VERSION,
        kind: 'relay-error',
        ...(envelope.id ? { id: envelope.id } : {}),
        payload: { code: 'DEVICE_OFFLINE', message: 'target device offline', dst: envelope.dst },
      });
      return;
    }
    // 被暂停的设备也不会发出任何帧。
    if (this.offline.has(senderId)) return;
    if (this.drop?.(senderId, envelope)) return;
    const destination = this.sockets.get(envelope.dst);
    if (!destination) return;
    if (envelope.kind === 'link-open') {
      this.deliveredLinkOpens.set(envelope.dst, (this.deliveredLinkOpens.get(envelope.dst) ?? 0) + 1);
    }
    destination.push({ ...envelope, src: senderId });
  }

  /** 以 `from` 的身份直接给 `to` 投递一帧。 */
  inject(from: string, to: string, envelope: Omit<Envelope, 'src' | 'dst'>): void {
    this.sockets.get(to)?.push({ ...envelope, src: from, dst: to } as Envelope);
  }

  linkOpensTo(deviceId: string): number {
    return this.deliveredLinkOpens.get(deviceId) ?? 0;
  }
}

function makeClient(relay: FlowRelay, deviceId: string): DeviceLinkClient {
  const client = new DeviceLinkClient({
    getWsUrl: () => 'ws://test/api/device-link/ws',
    getToken: async () => 'jwt-token',
    getHello: () => ({
      deviceName: deviceId,
      platform: 'linux',
      appVersion: '1.0.0',
      remoteControlEnabled: true,
      busy: false,
    }),
    createWebSocket: () => relay.makeWebSocket(deviceId) as never,
    timing: {
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      // relay 不回 pong;长时间推进时钟时不能因此断开整条连接。
      pingIntervalMs: 24 * 60 * 60_000,
      pongMissLimit: 4,
      requestTimeoutMs: 2_000,
    },
  });
  // 被控端行为:收到 link-open 就接受(与 dispatch 的 handleLinkOpen 等价的最小版本)。
  client.onFrame((env) => {
    if (!env.src || !env.id) return;
    if (env.kind === 'link-open') {
      client.sendLinkAccept(env.src, env.id, { appVersion: '1.0.0', allowlistHash: 'hash' });
    } else if (env.kind === 'invoke' && (env.payload as { channel?: string } | undefined)?.channel === 'test:ping') {
      client.sendInvokeResult(env.src, env.id, { ok: true, result: 'pong' });
    }
  });
  return client;
}

const OPEN_PAYLOAD = { controllerName: 'controller', protocolVersion: 1, appVersion: '1.0.0' };

/** 控制端 host 接线,与 index.ts 一致(去掉与本流程无关的 UI / 订阅部分)。 */
function wireController(ctrl: DeviceLinkClient) {
  const disabled = new Set<string>();
  /** 模拟仍持有出站订阅的设备(index.ts 的 snapshotSubscriptions)。 */
  const subscribed = new Set<string>();
  const openInFlight = new Map<string, Promise<unknown>>();
  const resets: string[] = [];
  const reopened: string[] = [];
  let openRemoteLinkCalls = 0;

  const openRemoteLink = (deviceId: string): Promise<unknown> => {
    const existing = openInFlight.get(deviceId);
    if (existing) return existing;
    openRemoteLinkCalls += 1;
    const request = ctrl.openLink(deviceId, OPEN_PAYLOAD);
    openInFlight.set(deviceId, request);
    const cleanup = (): void => {
      if (openInFlight.get(deviceId) === request) openInFlight.delete(deviceId);
    };
    void request.then(cleanup, cleanup);
    return request;
  };

  const loop = createTransportTimeoutReopenLoop({
    onReset: (deviceId) => resets.push(deviceId),
    onReopened: (deviceId) => {
      recovery.reset(deviceId);
      reopened.push(deviceId);
    },
    onGaveUp: (deviceId, lastError) => (isPermanentReopenError(lastError)
      ? recovery.reset(deviceId)
      : recovery.onGaveUp(deviceId)),
    onStarted: (deviceId) => recovery.track(deviceId),
    reopen: async (deviceId) => {
      if (!ctrl.isLinkReady(deviceId)) await openRemoteLink(deviceId);
    },
    shouldAbort: (deviceId) => shouldAbortTransportTimeoutReopen({
      clientOnline: ctrl.getStatus() === 'online',
      isOwner: true,
      controlDisabledLocally: disabled.has(deviceId),
      hasOutboundControlIntent: hasOutboundControlIntent(deviceId),
    }),
  });

  const hasOutboundControlIntent = (deviceId: string): boolean => !ctrl.isOutboundExplicitlyClosed(deviceId)
    && (subscribed.has(deviceId) || ctrl.hasOpenOutboundLink(deviceId) || ctrl.hasPendingRequestsTo(deviceId));
  const gate = (deviceId: string, needsOutboundReopen: boolean): boolean => shouldRecoverStalledOutboundLink({
    needsOutboundReopen,
    controlDisabledLocally: disabled.has(deviceId),
    revokedByRemote: false,
    clientOnline: ctrl.getStatus() === 'online',
    isOwner: true,
  });
  const recovery = createStalledOutboundRecovery({
    canRecover: (deviceId) => gate(deviceId, ctrl.needsOutboundReopen(deviceId)),
    canResume: (deviceId) => gate(
      deviceId,
      ctrl.needsOutboundReopen(deviceId)
        || (!ctrl.isLinkReady(deviceId) && hasOutboundControlIntent(deviceId)),
    ),
    trigger: (deviceId, opts) => loop.trigger(deviceId, opts),
    isReopening: (deviceId) => loop.isActive(deviceId),
    isRelayOnline: () => ctrl.getStatus() === 'online',
  });
  attachStalledOutboundRecovery(ctrl, recovery);
  // index.ts:relay 离线时重开循环全部终止。
  ctrl.onStatusChange((status) => {
    if (status !== 'online') loop.dispose();
  });
  // index.ts 的 link-close 路由:transport-timeout 重开,其它 reason 终止循环。
  ctrl.onFrame((env) => {
    if (env.kind !== 'link-close' || !env.src) return;
    routeLinkCloseForReopen((env.payload as { reason?: string } | undefined)?.reason, loop, env.src);
  });

  /** 与 index.ts closeRemoteLink 的相关步骤一致。 */
  const closeRemoteLink = (deviceId: string): void => {
    subscribed.delete(deviceId);
    loop.cancel(deviceId);
    recovery.reset(deviceId);
    openInFlight.delete(deviceId);
    ctrl.closeLink(deviceId, 'user');
  };

  return {
    loop,
    recovery,
    disabled,
    subscribed,
    resets,
    reopened,
    openRemoteLink,
    closeRemoteLink,
    openRemoteLinkCalls: () => openRemoteLinkCalls,
  };
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

async function setup() {
  const relay = new FlowRelay();
  const ctrl = makeClient(relay, 'ctrl');
  const vm = makeClient(relay, 'vm');
  // 同一 relay 上的健康邻居,用来验证故障半径。
  const nb = makeClient(relay, 'nb');
  const host = wireController(ctrl);
  ctrl.start();
  vm.start();
  nb.start();
  await settle(50);
  expect(ctrl.getStatus()).toBe('online');
  expect(vm.getStatus()).toBe('online');
  expect(nb.getStatus()).toBe('online');
  return { relay, ctrl, vm, nb, host };
}

/** 本机先正常打开远程控制。 */
async function establish(env: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const open = env.host.openRemoteLink('vm');
  await settle(10);
  await open;
  expect(env.ctrl.isLinkReady('vm')).toBe(true);
  expect(env.relay.linkOpensTo('vm')).toBe(1);
}

/**
 * 虚拟机被暂停。与 10-13 现场一致:先是一次普通请求吃到 DEVICE_OFFLINE(路由离线
 * 通知此刻发出,可靠链路却还是 ready),稍后可靠帧重发再吃到错误,链路才真正 down。
 * 返回路由离线通知发出那一刻链路是否 ready。
 */
async function pauseVm(env: Awaited<ReturnType<typeof setup>>): Promise<boolean> {
  let readyAtRouteOffline: boolean | undefined;
  const off = env.ctrl.onPeerRouteStateChanged((change) => {
    if (change.deviceId === 'vm' && readyAtRouteOffline === undefined) {
      readyAtRouteOffline = env.ctrl.isLinkReady('vm');
    }
  });
  env.relay.offline.add('vm');
  void env.ctrl.invoke('vm', { channel: 'test:ping', args: [] }).catch(() => undefined);
  for (let waited = 0; env.ctrl.isLinkReady('vm') && waited < 10_000; waited += 100) {
    await settle(100);
  }
  off();
  expect(readyAtRouteOffline).toBeDefined();
  expect(env.ctrl.isLinkReady('vm')).toBe(false);
  return readyAtRouteOffline!;
}

/** 一轮 5 次退避(0/1/2/4/8 秒)全部失败后的时间点。 */
const ONE_ROUND_MS = 20_000;

let env: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  vi.useFakeTimers();
  env = await setup();
});

afterEach(() => {
  env.host.loop.dispose();
  env.host.recovery.dispose();
  env.ctrl.stop();
  env.vm.stop();
  env.nb.stop();
  vi.useRealTimers();
});

describe('出站链路主动重开:完整流程', () => {
  it('虚拟机暂停后恢复,没有上线通知也能重开,且只多建一次链路', async () => {
    await establish(env);
    // 路由离线通知到达时链路还是 ready:只靠它的延后检查会错过,必须由「链路掉线」事件接上。
    expect(await pauseVm(env)).toBe(true);

    await settle(ONE_ROUND_MS);
    // 链路掉线立刻触发一轮:5 次 openLink 都被 relay 以 DEVICE_OFFLINE 拒绝。
    expect(env.host.openRemoteLinkCalls()).toBe(1 + 5);
    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(60_000);
    expect(env.relay.linkOpensTo('vm')).toBe(1);

    // 虚拟机恢复,但什么都不发:没有 presence 事件,也不发 transport-timeout / link-open。
    env.relay.drop = (sender) => sender === 'vm';
    env.relay.offline.delete('vm');
    await settle(50_000); // 距这一轮放弃还不到 60 秒。
    expect(env.relay.linkOpensTo('vm')).toBe(1);
    env.relay.drop = null;
    await settle(10_000);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.reopened).toEqual(['vm']);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.host.loop.isActive('vm')).toBe(false);
    // 只有路由离线那一次通知界面重置;定时重试是静默的。
    expect(env.host.resets).toEqual(['vm']);

    // 恢复之后没有遗留定时器再去建链。
    const callsAfterRecovery = env.host.openRemoteLinkCalls();
    await settle(30 * 60_000);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.openRemoteLinkCalls()).toBe(callsAfterRecovery);
  });

  it('对端恢复后先发来 transport-timeout:立即重开,不等定时器,也只建一次链路', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(true);

    // 对端自己的重试计时由 relay 丢掉,只留下这一帧恢复信号,确保时序确定。
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.offline.delete('vm');
    env.relay.inject('vm', 'ctrl', {
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      payload: { reason: 'transport-timeout' },
    });
    await settle(100);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.reopened).toEqual(['vm']);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.host.loop.isActive('vm')).toBe(false);

    await settle(30 * 60_000);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
  });

  it('长期离线时退避逐轮拉长,对端重新上线后从 60 秒重新算', async () => {
    await establish(env);
    await pauseVm(env);

    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(60_000);
    let calls = env.host.openRemoteLinkCalls();

    await settle(60_000 + ONE_ROUND_MS);
    expect(env.host.openRemoteLinkCalls() - calls).toBe(5);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(120_000);
    calls = env.host.openRemoteLinkCalls();

    await settle(120_000 + ONE_ROUND_MS);
    expect(env.host.openRemoteLinkCalls() - calls).toBe(5);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(240_000);

    // presence 报告重新可用(relay 这边仍不可达):立即重开,退避清零。
    calls = env.host.openRemoteLinkCalls();
    env.host.recovery.recover('vm', 'presence-online');
    await settle(ONE_ROUND_MS);
    expect(env.host.openRemoteLinkCalls() - calls).toBe(5);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(60_000);
    // 整个过程中对端一次 link-open 都没多收到。
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });

  it('多个恢复事件和用户手动打开同时发生,对端只收到一次 link-open', async () => {
    await establish(env);
    // 远程会话视图仍开着(有订阅):重开循环不会因「没有控制意图」提前停下。
    env.host.subscribed.add('vm');
    await pauseVm(env);
    // 链路掉线已经启动了一轮重开,此刻正在退避等待下一次尝试。
    expect(env.host.loop.isActive('vm')).toBe(true);
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.offline.delete('vm');

    // 路由离线的延后检查还没跑,presence 上线、可靠层重置、用户打开远程视图同时到达。
    env.host.recovery.recover('vm', 'presence-online');
    env.host.recovery.recover('vm', 'transport-reset');
    const userOpen = env.host.openRemoteLink('vm');
    await settle(10);
    await userOpen;

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);

    // 退避中的那次尝试到点后发现链路已就绪,不再多发 link-open,循环正常收尾。
    await settle(ONE_ROUND_MS);
    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.relay.linkOpensTo('vm')).toBe(2);

    await settle(30 * 60_000);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
  });

  it('用户在退避期间手动断开:定时器和循环都清掉,对端回来也不会被拉起', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(true);

    env.host.closeRemoteLink('vm');
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.ctrl.needsOutboundReopen('vm')).toBe(false);

    env.relay.offline.delete('vm');
    const calls = env.host.openRemoteLinkCalls();
    await settle(30 * 60_000);
    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });

  it('用户在一轮重试进行中断开:剩余的几次尝试不再发出', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(1_500); // 第 2 次尝试已失败,正在等第 3 次。
    expect(env.host.loop.isActive('vm')).toBe(true);
    const calls = env.host.openRemoteLinkCalls();

    env.host.closeRemoteLink('vm');
    env.relay.offline.delete('vm');
    await settle(30 * 60_000);

    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });

  it('对端发来永久关闭:已排期的重试作废,之后不会重开', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(true);

    env.relay.offline.delete('vm');
    env.vm.closeLink('ctrl', 'user');
    await settle(0);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.ctrl.needsOutboundReopen('vm')).toBe(false);

    const calls = env.host.openRemoteLinkCalls();
    await settle(30 * 60_000);
    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });

  it('退避期间链路由其他路径恢复(用户重新打开):旧定时器被清掉,不会再多建一次', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(true);

    env.relay.offline.delete('vm');
    const userOpen = env.host.openRemoteLink('vm');
    await settle(10);
    await userOpen;
    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.relay.linkOpensTo('vm')).toBe(2);

    await settle(30 * 60_000);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
  });

  it('本机禁用对该设备的控制后,定时重试到点也不会重开', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(true);

    env.host.disabled.add('vm');
    env.relay.offline.delete('vm');
    const calls = env.host.openRemoteLinkCalls();
    await settle(30 * 60_000);

    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });

  it('只被对方控制的入站链路断开时,本机不会反向建链', async () => {
    // 虚拟机控制本机。
    const open = env.vm.openLink('ctrl', OPEN_PAYLOAD);
    await settle(10);
    await open;
    expect(env.relay.linkOpensTo('ctrl')).toBe(1);

    env.relay.offline.add('vm');
    void env.ctrl.invoke('vm', { channel: 'test:ping', args: [] }).catch(() => undefined);
    await settle(0);
    expect(env.ctrl.needsOutboundReopen('vm')).toBe(false);

    env.relay.offline.delete('vm');
    await settle(30 * 60_000);
    expect(env.host.openRemoteLinkCalls()).toBe(0);
    expect(env.relay.linkOpensTo('vm')).toBe(0);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
  });
  it('健康邻居在故障 peer 多轮重开期间零感知:请求照常完成,链路不复位、不重建', async () => {
    await establish(env);
    const openNb = env.host.openRemoteLink('nb');
    await settle(10);
    await openNb;
    expect(env.ctrl.isLinkReady('nb')).toBe(true);
    const lost: string[] = [];
    env.ctrl.onOutboundLinkLost((deviceId) => lost.push(deviceId));

    await pauseVm(env);
    // 第一轮、慢速重试、第二轮,每个阶段都向邻居发请求。
    for (const advance of [5_000, ONE_ROUND_MS, 60_000, ONE_ROUND_MS]) {
      await settle(advance);
      const ping = env.ctrl.invoke('nb', { channel: 'test:ping', args: [] });
      await settle(10);
      await expect(ping).resolves.toMatchObject({ ok: true, result: 'pong' });
      expect(env.ctrl.isLinkReady('nb')).toBe(true);
    }

    // 故障 peer 确实经历了多轮重开。
    expect(env.host.openRemoteLinkCalls()).toBeGreaterThanOrEqual(2 + 10);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(120_000);
    // 邻居:没有被重开、没有掉线事件、没有界面重置、也不在恢复中。
    expect(env.relay.linkOpensTo('nb')).toBe(1);
    expect(lost).not.toContain('nb');
    expect(env.host.resets).not.toContain('nb');
    expect(env.host.recovery.isRecovering('nb')).toBe(false);
    expect(env.ctrl.getStatus()).toBe('online');
  });

  it('本机 relay 断线期间到点的重试不丢:重新上线后接着重开', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(ONE_ROUND_MS);
    expect(env.host.recovery.pendingRetryDelayMs('vm')).toBe(60_000);

    // 本机到 relay 的连接断了,而且一时连不回去;慢速重试在这期间到点。
    env.relay.unreachable.add('ctrl');
    env.relay.disconnect('ctrl');
    await settle(100);
    expect(env.ctrl.getStatus()).not.toBe('online');
    const calls = env.host.openRemoteLinkCalls();
    await settle(60_000);
    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    // 虚拟机已经回来,本机 relay 也恢复;没有订阅,也没有新的 presence 事件。
    env.relay.offline.delete('vm');
    // 对端恢复后不发 transport-timeout,只能靠本机自己接上。
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.unreachable.delete('ctrl');
    await settle(200);
    expect(env.ctrl.getStatus()).toBe('online');

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
  });

  it('本机 relay 断线终止了进行中的重开循环:重新上线后接着重开', async () => {
    await establish(env);
    await pauseVm(env);
    await settle(1_500); // 第一轮还在退避中。
    expect(env.host.loop.isActive('vm')).toBe(true);

    env.relay.unreachable.add('ctrl');
    env.relay.disconnect('ctrl');
    await settle(100);
    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    env.relay.offline.delete('vm');
    // 对端恢复后不发 transport-timeout,只能靠本机自己接上。
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.unreachable.delete('ctrl');
    await settle(200);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
  });
  it('掉线事件推迟处理时撞上本机 relay 断线:仍登记为恢复中,重新上线后重开', async () => {
    await establish(env);
    // 链路掉线通知发出后、推迟一轮的处理执行前,本机 relay 断开(微任务先于 0ms 定时器)。
    let raced = false;
    env.ctrl.onOutboundLinkLost(() => {
      if (raced) return;
      raced = true;
      queueMicrotask(() => {
        env.relay.unreachable.add('ctrl');
        env.relay.disconnect('ctrl');
      });
    });
    expect(await pauseVm(env)).toBe(true);
    expect(raced).toBe(true);
    expect(env.ctrl.getStatus()).not.toBe('online');
    expect(env.host.openRemoteLinkCalls()).toBe(1);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    env.relay.offline.delete('vm');
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.unreachable.delete('ctrl');
    await settle(200);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.relay.linkOpensTo('vm')).toBe(2);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
  });

  it('对端 transport-timeout 直接启动的重开被本机 relay 断线终止:重新上线后接着重开', async () => {
    await establish(env);
    // 对端发来瞬时重置后不再回应(帧被静默丢弃,不产生 DEVICE_OFFLINE / 路由离线事件),
    // 所以只有 link-close 路由直接启动的重开循环,不经停滞恢复的任何其它入口。
    env.relay.drop = (sender, envelope) => envelope.dst === 'vm' || sender === 'vm';
    env.relay.inject('vm', 'ctrl', {
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      payload: { reason: 'transport-timeout' },
    });
    await settle(1_500); // 循环在退避中。
    expect(env.host.loop.isActive('vm')).toBe(true);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    env.relay.unreachable.add('ctrl');
    env.relay.disconnect('ctrl');
    await settle(100);
    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    // 对端恢复回应,但不再发 transport-timeout。
    env.relay.drop = (sender, envelope) => sender === 'vm' && envelope.kind === 'link-close';
    env.relay.unreachable.delete('ctrl');
    await settle(200);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
  });
  it('出站握手完成前被本机 relay 断线终止的直接入口重开:按原控制意图在重新上线后接着重开', async () => {
    // 本机从未建成到 vm 的出站链路,但仍在控制它(这里用订阅表示;在途请求同一判据)。
    // 像 before-link 那样由其它入口直接启动循环,vm 暂不回应,握手完成前本机 relay 断开。
    env.host.subscribed.add('vm');
    env.relay.drop = (sender, envelope) => envelope.dst === 'vm' || sender === 'vm';
    env.host.loop.trigger('vm');
    await settle(500);
    expect(env.host.loop.isActive('vm')).toBe(true);
    expect(env.ctrl.hasOpenOutboundLink('vm')).toBe(false);
    expect(env.host.recovery.isRecovering('vm')).toBe(true);

    env.relay.unreachable.add('ctrl');
    env.relay.disconnect('ctrl');
    await settle(100);
    expect(env.host.loop.isActive('vm')).toBe(false);

    env.relay.drop = null;
    env.relay.unreachable.delete('ctrl');
    await settle(200);

    expect(env.ctrl.isLinkReady('vm')).toBe(true);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
  });
  it('对端关闭远程控制(REMOTE_DISABLED):不主动重开,直接入口的循环失败后也不排慢速重试', async () => {
    await establish(env);
    env.relay.remoteDisabled.add('vm');
    void env.ctrl.invoke('vm', { channel: 'test:ping', args: [] }).catch(() => undefined);
    for (let waited = 0; env.ctrl.isLinkReady('vm') && waited < 10_000; waited += 100) {
      await settle(100);
    }
    expect(env.ctrl.isLinkReady('vm')).toBe(false);
    await settle(ONE_ROUND_MS);
    expect(env.host.openRemoteLinkCalls()).toBe(1);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);

    // 其它入口直接启动的一轮也以 REMOTE_DISABLED 告终:不再排 60 秒起的慢速重试。
    env.host.loop.trigger('vm');
    await settle(ONE_ROUND_MS);
    expect(env.host.loop.isActive('vm')).toBe(false);
    expect(env.host.recovery.hasPendingRetry('vm')).toBe(false);
    expect(env.host.recovery.isRecovering('vm')).toBe(false);
    const calls = env.host.openRemoteLinkCalls();
    await settle(30 * 60_000);
    expect(env.host.openRemoteLinkCalls()).toBe(calls);
    expect(env.relay.linkOpensTo('vm')).toBe(1);
  });
});

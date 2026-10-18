/**
 * 出站可靠链路「曾经连上、现在发不出去」时的主动重开调度(控制端,Desktop main)。
 *
 * 对端(典型是被宿主机暂停的虚拟机)恢复后,presence 上线通知可能不来,界面也可能
 * 不再发请求;只等对端重开就会两边互等。这里在链路掉线 / 路由离线 / 可靠层重置 /
 * presence 重新可用这几类事件上立即重开这一个对端,
 * 一轮用完后按 60 秒起步、翻倍、封顶 10 分钟的间隔再试。
 *
 * 去重:实际重开交给 transport-timeout 重开循环(per-device 单飞),它再调
 * openRemoteLink(同设备在途建链复用)。本模块每台设备最多挂一个定时器,不会
 * 自己发 link-open。
 *
 * 清理:链路以任何方式恢复、被任一端关闭、对端证明自己还活着,或判定不再需要
 * 重开时,定时器和退避一起清掉;不会留下迟到的定时器去重开已关闭或已恢复的链路。
 *
 * 本机 relay 断线不算「不再需要」:断线期间到点的重试、以及被 relay 离线终止的重开
 * 循环,都保留在恢复中的设备集合里,relay 重新上线后接着重开。presence 是增量流,
 * 没有订阅的设备在重连后不一定再有任何事件。
 */
import type { DeviceLinkClient } from '@cindy/device-link';
import { stalledOutboundRetryDelayMs } from './linkRecovery';

type Timer = ReturnType<typeof setTimeout>;

export type StalledOutboundRecoveryReason =
  | 'link-lost'
  | 'route-offline'
  | 'transport-reset'
  | 'presence-online'
  | 'relay-online'
  | 'retry-timer';

export interface StalledOutboundRecoveryDeps {
  /** 授权与状态门:出站链路需要重开、relay 在线、本机持有、未禁用、未被撤权。 */
  canRecover(deviceId: string): boolean;
  /** 本机 relay 是否在线。离线是暂时的:不清掉恢复中的设备,等重新上线再试。 */
  isRelayOnline(): boolean;
  /** 交给 per-device 单飞的重开循环。 */
  trigger(deviceId: string, opts: { notifyReset: boolean }): void;
  /** 重开循环是否已在跑。在跑时不再重复触发,也不重复通知界面。 */
  isReopening(deviceId: string): boolean;
  log?: { info(msg: string): void };
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export interface StalledOutboundRecovery {
  recover(deviceId: string, reason: StalledOutboundRecoveryReason): void;
  /** 重开循环这一轮次数用完。 */
  onGaveUp(deviceId: string): void;
  /** 链路已恢复 / 已关闭 / 对端仍活着:清定时器,退避从头算。 */
  reset(deviceId: string): void;
  /** 本机 relay 重新上线:恢复中的设备逐个重新判断并重开。 */
  resumeAfterRelayOnline(): void;
  dispose(): void;
  /** 测试观察点。 */
  hasPendingRetry(deviceId: string): boolean;
  /** 测试观察点:是否仍在恢复中(含 relay 离线期间暂停的设备)。 */
  isRecovering(deviceId: string): boolean;
  /** 测试观察点:已排期的下一轮还要等多久(ms),没有则 undefined。 */
  pendingRetryDelayMs(deviceId: string): number | undefined;
}

export function createStalledOutboundRecovery(
  deps: StalledOutboundRecoveryDeps,
): StalledOutboundRecovery {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const timers = new Map<string, { timer: Timer; delayMs: number }>();
  /** 已经连续用完了几轮。 */
  const rounds = new Map<string, number>();
  /** 恢复中的设备:触发过重开、还没恢复也没被判定不再需要。relay 重连后据此接着重开。 */
  const recovering = new Set<string>();

  const clearPendingRetry = (deviceId: string): void => {
    const entry = timers.get(deviceId);
    if (!entry) return;
    clearTimer(entry.timer);
    timers.delete(deviceId);
  };

  const reset = (deviceId: string): void => {
    rounds.delete(deviceId);
    recovering.delete(deviceId);
    clearPendingRetry(deviceId);
  };

  const recover = (deviceId: string, reason: StalledOutboundRecoveryReason): void => {
    // 事件本身就是新证据(新一次断开、对端或本机重新上线):退避从头算,马上重开。
    if (reason !== 'retry-timer') {
      rounds.delete(deviceId);
      clearPendingRetry(deviceId);
    }
    if (!deps.isRelayOnline()) {
      // 暂时无法判断也无法重开;已在恢复中的设备留着,relay 上线后由 resumeAfterRelayOnline 接上。
      return;
    }
    if (!deps.canRecover(deviceId)) {
      reset(deviceId);
      return;
    }
    recovering.add(deviceId);
    // 同一次掉线常常同时带来路由离线和链路掉线两个事件;循环在跑时它会自己收尾,
    // 失败后经 onGaveUp 回到这里排期。
    if (deps.isReopening(deviceId)) return;
    deps.log?.info(`re-opening stalled outbound link for ${deviceId.slice(0, 8)} (${reason})`);
    // 定时重试时链路状态没有新变化,界面已在上一次重置时作废过,不再重复通知;
    // transport-reset 的通知已由调用方发过。成功后仍会发 PEER_LINK_REOPENED。
    deps.trigger(deviceId, {
      notifyReset: reason === 'link-lost' || reason === 'route-offline' || reason === 'presence-online',
    });
  };

  return {
    recover,
    onGaveUp(deviceId) {
      recovering.add(deviceId);
      if (timers.has(deviceId)) return;
      const round = rounds.get(deviceId) ?? 0;
      rounds.set(deviceId, round + 1);
      const delayMs = stalledOutboundRetryDelayMs(round);
      const timer = setTimer(() => {
        if (timers.get(deviceId)?.timer !== timer) return;
        timers.delete(deviceId);
        recover(deviceId, 'retry-timer');
      }, delayMs);
      (timer as { unref?: () => void }).unref?.();
      timers.set(deviceId, { timer, delayMs });
    },
    reset,
    resumeAfterRelayOnline() {
      for (const deviceId of [...recovering]) recover(deviceId, 'relay-online');
    },
    dispose() {
      for (const entry of timers.values()) clearTimer(entry.timer);
      timers.clear();
      rounds.clear();
      recovering.clear();
    },
    hasPendingRetry: (deviceId) => timers.has(deviceId),
    isRecovering: (deviceId) => recovering.has(deviceId),
    pendingRetryDelayMs: (deviceId) => timers.get(deviceId)?.delayMs,
  };
}

type RecoveryClient = Pick<
  DeviceLinkClient,
  | 'onPeerRouteStateChanged'
  | 'onPeerTransportReset'
  | 'onPeerStreamAccepted'
  | 'onFrame'
  | 'onOutboundLinkLost'
  | 'onStatusChange'
>;

/**
 * 把 client 事件接到调度上。presence 上线由 host 自己判定可用性翻转后调用
 * `recover(id, 'presence-online')`,不在这里接。
 */
export function attachStalledOutboundRecovery(
  client: RecoveryClient,
  recovery: StalledOutboundRecovery,
): () => void {
  const later = (fn: () => void): void => {
    const timer = setTimeout(fn, 0);
    (timer as { unref?: () => void }).unref?.();
  };
  const offs = [
    // 路由离线通知按链路代次去重,而且常由 legacy 请求先触发,那时可靠链路可能还是
    // ready;所以另外监听「出站链路真正掉线」。两者都推迟一轮再判断,重复触发由
    // 重开循环的单飞去重吸收。
    client.onPeerRouteStateChanged((change) => {
      if (change.state !== 'offline') return;
      later(() => recovery.recover(change.deviceId, 'route-offline'));
    }),
    client.onOutboundLinkLost((deviceId) => {
      later(() => recovery.recover(deviceId, 'link-lost'));
    }),
    // 本机 relay 断线期间到点的重试、被断线终止的重开循环,都在重新上线后接上。
    client.onStatusChange((status) => {
      if (status === 'online') later(() => recovery.resumeAfterRelayOnline());
    }),
    client.onPeerTransportReset(({ deviceId }) => recovery.recover(deviceId, 'transport-reset')),
    // 出站握手以任何路径完成(本轮重开、用户打开远程视图、订阅重放):不再需要定时重试。
    client.onPeerStreamAccepted((deviceId) => recovery.reset(deviceId)),
    client.onFrame((env) => {
      // transport-timeout:对端还活着,重开循环由 link-close 路由接管,退避从头算;
      // 其它 reason 是永久关闭,不得留下定时器。
      if (env.kind === 'link-close' && env.src) recovery.reset(env.src);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

import { DeviceLinkError, parseFsWatchTopic } from '@cindy/device-link';

/**
 * 出站可靠链路已经断了、但没有被用户关掉时，要主动重新 openLink。
 * 不看 presence：对端暂停恢复后，本机可能一直停在过期的离线状态，
 * 等不到「重新上线」也不会再发请求。只重开这一个对端，不重连共享中转。
 */
export function shouldRecoverStalledOutboundLink(input: {
  needsOutboundReopen: boolean;
  controlDisabledLocally: boolean;
  revokedByRemote: boolean;
  clientOnline: boolean;
  isOwner: boolean;
}): boolean {
  return input.needsOutboundReopen
    && input.clientOnline
    && input.isOwner
    && !input.controlDisabledLocally
    && !input.revokedByRemote;
}

const STALLED_OUTBOUND_RETRY_BASE_MS = 60_000;
const STALLED_OUTBOUND_RETRY_MAX_MS = 10 * 60_000;

/**
 * 一轮重开用完后，下一轮等多久。第 0 轮 60 秒，之后翻倍，最长 10 分钟。
 * 长期关机的设备不能每分钟都重试一遍；对端重新上线时 presence 会直接触发重开。
 */
export function stalledOutboundRetryDelayMs(round: number): number {
  const exponent = Math.max(0, Math.floor(round));
  return Math.min(STALLED_OUTBOUND_RETRY_BASE_MS * 2 ** exponent, STALLED_OUTBOUND_RETRY_MAX_MS);
}

/** Recover before admitting a new request; never replay an already sent operation. */
export async function ensureInvokeLinkReady(
  needsRecovery: () => boolean,
  reopen: () => Promise<unknown>,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  if (!needsRecovery()) return;
  await reopen();
  assertCurrent();
}

/** 打开具体远程会话或文件树监听时必须先建立 streaming link；轻量 sessions 列表订阅不依赖。 */
export function requiresSessionLink(topics: readonly string[]): boolean {
  return topics.some((topic) => (
    (topic.startsWith('session:') && topic.length > 'session:'.length)
    || parseFsWatchTopic(topic) !== null
  ));
}

/**
 * LINK_NOT_OPEN 由 DeviceLinkClient 在真正发帧前抛出；PEER_RESET 只用于已经
 * 明确标记为幂等读的请求。两者都先重开链路再重试一次，已经发出的写请求或其它
 * 错误绝不重试，避免 enqueue / send 等写操作重复执行。
 */
export async function invokeWithClosedLinkRecovery<T>(
  invoke: () => Promise<T>,
  reopen: () => Promise<unknown>,
  beforeRetry?: () => void,
  onRetryGuardFailure?: () => void,
): Promise<T> {
  try {
    return await invoke();
  } catch (err) {
    const retryable = err instanceof DeviceLinkError
      && (
        (err.code === 'LINK_NOT_OPEN' && err.inFlight !== true)
        || (err.code === 'PEER_RESET' && err.inFlight === true)
      );
    if (!retryable) {
      throw err;
    }
  }

  await reopen();
  try {
    beforeRetry?.();
  } catch (err) {
    try {
      onRetryGuardFailure?.();
    } catch {
      // 清理是 best-effort；保留撤权守卫错误作为调用方可见结果。
    }
    throw err;
  }
  return invoke();
}

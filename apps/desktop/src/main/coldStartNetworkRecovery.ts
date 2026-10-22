/**
 * 冷启动因传输层失败(status 0)没能恢复会话时的重试节奏。
 *
 * 开机自启是主要场景:系统登录项常常早于网络就绪执行,首次 `/api/auth/refresh`
 * 必然拿不到连接。此时本地 refresh token 仍有效,失败也被判定为 transient,
 * 但进程内没有其它入口回到登录态——refreshTimer 只在成功分支安排。结果就是
 * 这一次启动停在登录页,用户被迫重新收验证码。
 *
 * 本模块只管「什么时候再试」,不碰凭证、不判断失败类型:调用方只对 status 0
 * 的失败调用它。与 Electron 解耦,便于单测(authManager 本身依赖 Electron)。
 */

/** 累计约 67s,覆盖开机后 DHCP / VPN / 代理就绪的常见延迟。 */
export const COLD_START_NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

export interface ColdStartNetworkRecoveryDeps {
  /** 当前登录代次是否仍然一致(用户已手动登录 / 登出则作废)。 */
  isCurrent(): boolean;
  /** 是否仍停在冷启动的未登录状态。 */
  isSignedOut(): boolean;
  /** 重试一次;返回 true 表示会话已恢复,停止后续尝试。 */
  retry(): Promise<boolean>;
  delaysMs?: readonly number[];
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onAttempt?: (info: { attempt: number; delayMs: number }) => void;
  onExhausted?: (attempts: number) => void;
  onError?: (error: unknown) => void;
}

export interface ColdStartNetworkRecovery {
  /** 取消尚未触发的重试;重复调用安全。 */
  cancel(): void;
}

/**
 * 安排一串有界的冷启动重试。
 *
 * 每次重试成功后停止(登录态由重试路径自己广播给 renderer);失败则排下一轮,
 * 直到节奏用完。取消 / 代次变化 / 已不再是未登录状态,三者任一都立即停止。
 */
export function startColdStartNetworkRecovery(
  deps: ColdStartNetworkRecoveryDeps,
): ColdStartNetworkRecovery {
  const delays = deps.delaysMs ?? COLD_START_NETWORK_RETRY_DELAYS_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let attempt = 0;

  const arm = (): void => {
    if (cancelled) return;
    const delayMs = delays[attempt];
    if (delayMs === undefined) {
      timer = null;
      deps.onExhausted?.(delays.length);
      return;
    }
    attempt += 1;
    timer = setTimeoutFn(() => {
      timer = null;
      if (cancelled || !deps.isCurrent() || !deps.isSignedOut()) return;
      deps.onAttempt?.({ attempt, delayMs });
      void deps.retry().then(
        (ok) => {
          if (ok || cancelled || !deps.isCurrent()) return;
          arm();
        },
        (error) => {
          deps.onError?.(error);
          if (!cancelled && deps.isCurrent()) arm();
        },
      );
    }, delayMs);
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
  };
}

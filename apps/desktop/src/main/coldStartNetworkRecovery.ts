/**
 * 冷启动因传输层失败(status 0)没能恢复会话时的重试节奏。
 *
 * 开机自启是主要场景:系统登录项常常早于网络就绪执行,首次 `/api/auth/refresh`
 * 必然拿不到连接。此时本地 refresh token 仍有效,失败也被判定为 transient,
 * 但进程内没有其它入口回到登录态——refreshTimer 只在成功分支安排。结果就是
 * 这一次启动停在登录页,用户被迫重新收验证码。
 *
 * 本模块只管「什么时候再试」,不碰凭证:调用方只对传输层失败启动它,并且每次
 * 重试后要明确回答「继续还是停止」。`continue` 只在该次失败仍是传输层失败时为真,
 * 429 / 5xx / 确定性失效都必须停下,不按短间隔继续撞服务端。
 * 与 Electron 解耦,便于单测(authManager 本身依赖 Electron)。
 */

/** 累计约 67s,覆盖开机后 DHCP / VPN / 代理就绪的常见延迟。 */
export const COLD_START_NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** 一次重试的结果:恢复了 / 仍是传输层失败可以继续 / 其它失败必须停止。 */
export type ColdStartRecoveryAttempt = 'recovered' | 'continue' | 'stop';

export interface ColdStartNetworkRecoveryDeps {
  /**
   * 是否仍处于本次冷启动流程。这里不复用登录代次:未登录态提交本身会推进
   * `authStateEpoch`,但那正是重试的前置条件。用户登录 / 登出 / 进入本地模式
   * 由 `isSignedOut` 之外的显式取消负责。
   */
  isCurrent(): boolean;
  /** 是否仍停在冷启动的未登录状态。 */
  isSignedOut(): boolean;
  /** 重试一次;必须明确回答继续还是停止。 */
  retry(): Promise<ColdStartRecoveryAttempt>;
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
 * 每次重试后按结果收口:`recovered` / `stop` 立即结束,`continue` 才排下一轮。
 * 取消 / 已不再是未登录状态,两者任一都停止。
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
        (result) => {
          if (result === 'continue' && !cancelled && deps.isCurrent()) arm();
        },
        (error) => {
          // 崩溃不等于网络已恢复:记日志后停止,把下一次机会留给下一次启动。
          deps.onError?.(error);
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

export interface ColdStartRecoveryLifecycleDeps {
  /** 当前 authStateEpoch。 */
  epoch(): number;
  /** 当前应用会话的 mode。 */
  mode(): string;
  /** 启动重试器;返回 cancel。 */
  start(): () => void;
  /** 进程内最多允许启动几条链;默认 2(首次失败 + 一轮重试后再失败)。 */
  maxChains?: number;
  onStarted?: () => void;
  onExhausted?: () => void;
}

/**
 * 冷启动恢复器的生命周期:只允许在「未登录态提交之后」存在。
 *
 * 背景:未登录态提交会经 withAccountFreeOwnerCommit → clearAuth 取消已存在的
 * 恢复器并推进 authStateEpoch。因此恢复器必须在该提交 settle 之后才创建;
 * 提前创建会被立刻清掉,首次重试永不执行(PR #6741 review)。
 *
 * 本模块把「什么情况下允许创建 / 何时必须取消」收在一处,便于单测:真实的
 * authManager 只在提交返回后调用 `arm()`。
 */
export class ColdStartRecoveryLifecycle {
  private cancelCurrent: (() => void) | null = null;
  private pending = false;
  private started = false;
  private minimumEpoch = 0;
  private chainsStarted = 0;

  constructor(private readonly deps: ColdStartRecoveryLifecycleDeps) {}

  /**
   * 提交前登记:提交会取消任何已存在的恢复器,因此这里只记下待启动。
   * 已启动的链不动它 —— 冷启动超时转后台后原流程迟到失败会再进一次失败分支,
   * 不能把节奏重来一遍;重试自身的失败会先经 clearAuth 取消,再走到这里。
   */
  request(): void {
    this.pending = true;
  }

  /**
   * 提交完成后启动。要求仍处于未登录态、且这条链尚未启动。
   * 用户手动登录 / 登出会先走 clearAuth → `cancel()`,因此到这里时 pending 已清。
   */
  arm(): void {
    if (!this.pending) return;
    this.pending = false;
    if (this.started || this.deps.mode() !== 'signed-out') return;
    if (this.chainsStarted >= (this.deps.maxChains ?? 2)) {
      this.deps.onExhausted?.();
      return;
    }
    this.chainsStarted += 1;
    this.started = true;
    this.minimumEpoch = this.deps.epoch();
    this.cancelCurrent = this.deps.start();
    this.deps.onStarted?.();
  }

  /**
   * 取消当前恢复器。默认同时清掉待启动登记(显式登出 / 用户登录)。
   * 未登录态提交内部调用的 `clearAuth` 传 `keepPending`,否则会把刚登记的
   * 待启动一起抹掉 —— 那正是本次要恢复的路径。
   */
  cancel(opts: { keepPending?: boolean } = {}): void {
    if (!opts.keepPending) this.pending = false;
    this.started = false;
    this.cancelCurrent?.();
    this.cancelCurrent = null;
  }

  /**
   * 当前恢复器是否仍应存活。必须**严格相等**:手动登录会先递增 authStateEpoch、
   * 再提交 cloud owner;用 `>=` 会让旧恢复器在登录事务中再跑一次 initialize(),
   * 与手动登录竞争同一枚 refresh token。
   */
  isCurrent(): boolean {
    return this.started && this.deps.epoch() === this.minimumEpoch;
  }
}

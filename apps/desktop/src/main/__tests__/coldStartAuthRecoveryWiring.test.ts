/**
 * 冷启动失败分支的接线守卫(authManager 依赖 Electron,不能直接 import)。
 *
 * 守护的契约:只有「没有服务端响应的传输层失败(status 0)」才进入自动恢复;
 * 确定性凭据失效、device-mismatch、replacement-retry、清单不可用都不许被
 * 顺手拖进来。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function coldStartFailureBranch(): string {
  const start = authSource.indexOf('if (!refreshResult.ok) {');
  const end = authSource.indexOf(
    'const refreshData = refreshResult.data as RefreshResponse;',
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return authSource.slice(start, end);
}

function recoveryScheduler(): string {
  const start = authSource.indexOf('function scheduleColdStartNetworkRecovery(');
  const end = authSource.indexOf('function scheduleRefreshRetryAfterTransientFailure', start);
  expect(start).toBeGreaterThan(-1);
  return authSource.slice(start, end);
}

describe('cold start auth recovery wiring', () => {
  it('只有传输层失败接入自动恢复', () => {
    const body = coldStartFailureBranch();
    expect(body).toContain('if (refreshResult.status === 0) {');
    expect(body).toContain('scheduleColdStartNetworkRecovery(authStateEpoch);');
    // 确定性失效仍走原来的清凭证出口,不能变成自动重试。
    expect(body).toContain("action.kind === 'definitive-failure'");
    expect(body).toContain('clearConfirmedDeadRefreshTokens(');
  });

  it('恢复调度复用运行时 refresh,并按登录代次与登录态收口', () => {
    const body = recoveryScheduler();
    expect(body).toContain('startColdStartNetworkRecovery({');
    expect(body).toContain('isCurrent: () => authStateEpoch === epoch');
    expect(body).toContain("getActiveAppSession().mode === 'signed-out'");
    // 重跑完整冷启动，而不是只调 refresh()：后者会漏掉 legacy owner
    // namespace 认领与 allowUnclaimedVault 的首次写入。
    expect(body).toContain('retry: retryColdStartAuthSession');
    expect(authSource).toContain('return initialize().then(');
  });

  it('整条恢复链一个进程只启动一次，避免重试自己把节奏重置成无限重试', () => {
    const body = recoveryScheduler();
    expect(body).toContain('if (coldStartNetworkRecoveryStarted) return;');
    expect(body).toContain('coldStartNetworkRecoveryStarted = true;');
  });

  it('登出 / 会话清除时取消尚未触发的重试', () => {
    const start = authSource.indexOf('function clearAuth(');
    const end = authSource.indexOf('if (!opts.preservePersistedRefreshToken)', start);
    const body = authSource.slice(start, end);
    expect(body).toContain('coldStartNetworkRecovery?.cancel();');
    expect(body).toContain('coldStartNetworkRecoveryStarted = false;');
  });
});

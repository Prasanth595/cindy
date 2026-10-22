/**
 * 冷启动断网恢复的静态契约守卫(authManager 依赖 Electron，无法在 unit 里 import)。
 *
 * 失效后果：
 *  - 在 `finishColdStartSignedOut()` 之前启动恢复器：该函数内部的
 *    `withAccountFreeOwnerCommit → clearAuth` 会取消恢复器并推进代次，首次重试
 *    永不执行，用户联网后仍停在登录页。
 *  - 把确定性失效 / 429 也当成可继续：已确认无效的凭据会被反复拿去撞服务端。
 *
 * 行为侧覆盖见 `coldStartNetworkRecovery.test.ts` 的 lifecycle 用例；这里只守
 * authManager 里的调用顺序与取消点。
 *
 * 规则依据：docs/dev-rules/engineering-conventions.md §3.2（跨文件静态契约进 guard）。
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

describe('cold start auth recovery boundary', () => {
  it('先登记、提交未登录态、再 arm', () => {
    const body = coldStartFailureBranch();
    const requestIdx = body.indexOf('coldStartRecovery.request()');
    const commitIdx = body.indexOf('await finishColdStartSignedOut(');
    const armIdx = body.indexOf('coldStartRecovery.arm()');
    expect(requestIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeGreaterThan(-1);
    expect(requestIdx).toBeLessThan(commitIdx);
    expect(commitIdx).toBeLessThan(armIdx);
  });

  it('按 status 判定传输层失败，确定性失效仍清凭证', () => {
    const body = coldStartFailureBranch();
    expect(body).toContain('if (refreshResult.status === 0) coldStartRecovery.request();');
    expect(body).toContain("action.kind === 'definitive-failure'");
    expect(body).toContain('clearConfirmedDeadRefreshTokens(');
  });

  it('重试结果区分继续与停止，确定性失效 / 无凭据都停手', () => {
    const start = authSource.indexOf('async function retryColdStartAuthSession(');
    const end = authSource.indexOf('\n}\n', start);
    const body = authSource.slice(start, end);
    expect(body).toContain("return 'recovered'");
    expect(body).toContain('hasNoPersistedAuthCredentials()');
    expect(body).toContain("lastColdStartFailureWasTransport ? 'continue' : 'stop'");
  });

  it('恢复成功接回冷启动统计同意迁移通道', () => {
    expect(authSource).toContain('if (coldStartRetryInFlight) coldStartRecoveredHandler?.(recoveredState);');
    expect(authSource).toContain('setColdStartRecoveredHandler');
    const bootstrapSource = readFileSync(
      resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
      'utf8',
    );
    expect(bootstrapSource).toContain('authManager.setColdStartRecoveredHandler');
    expect(bootstrapSource).toContain('noteAuthColdStartState(recovered, null);');
  });

  it('20s 超时路径不启动重试，避免用已消费的旧 token 再请求', () => {
    const start = authSource.indexOf('onTimeout: async () => {');
    const end = authSource.indexOf('onLateResult:', start);
    const body = authSource.slice(start, end);
    expect(body).toContain(
      "recoverAccountFreeOwnerAtStartup('signed-out', 'cold-start-timeout-recovery')",
    );
    // refresh 可能已在服务端轮换、只是响应没回来;超时后重发会用旧 token
    // 命中 INVALID_REFRESH_TOKEN 并清凭证。
    expect(body).not.toContain('coldStartRecovery.request()');
    expect(body).not.toContain('coldStartRecovery.arm()');
  });

  it('清会话时取消恢复器，且恢复器要求代次严格相等', () => {
    const start = authSource.indexOf('function clearAuth(');
    const end = authSource.indexOf('if (!opts.preservePersistedRefreshToken)', start);
    expect(authSource.slice(start, end)).toContain(
      'coldStartRecovery.cancel({ keepPending: opts.keepColdStartRecoveryPending === true });',
    );

    const recoveryStart = authSource.indexOf(
      'const coldStartRecovery: ColdStartRecoveryLifecycle =',
    );
    const recoveryEnd = authSource.indexOf(
      'function scheduleRefreshRetryAfterTransientFailure',
      recoveryStart,
    );
    const body = authSource.slice(recoveryStart, recoveryEnd);
    expect(body).toContain('epoch: () => authStateEpoch');
    expect(body).toContain('mode: () => getActiveAppSession().mode');
    expect(body).toContain('isCurrent: () => coldStartRecovery.isCurrent()');

    // 手动登录会先递增代次、再提交 cloud owner;`>=` 会让旧恢复器在登录事务中
    // 再跑一次 initialize()，与手动登录竞争同一枚 refresh token。
    // 直接读生产模块的公开契约对象,不截取源码片段。
    const lifecycleSource = readFileSync(
      resolve(process.cwd(), 'src/main/coldStartNetworkRecovery.ts'),
      'utf8',
    );
    expect(lifecycleSource).toContain('this.deps.epoch() === this.minimumEpoch');
    expect(lifecycleSource).not.toContain('this.deps.epoch() >= this.minimumEpoch');
  });
});

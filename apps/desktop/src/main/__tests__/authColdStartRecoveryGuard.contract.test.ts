/**
 * 冷启动断网恢复的静态契约守卫(authManager 依赖 Electron，无法在 unit 里 import)。
 *
 * 失效后果：若把确定性失效、DEVICE_MISMATCH 或 replacement-retry 也接进自动重试，
 * 已确认无效的凭据会被反复拿去撞服务端；反过来漏掉 status 0，开机断网时用户
 * 又会停在登录页被迫重新收验证码。
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
  const end = authSource.indexOf('const refreshData = refreshResult.data as RefreshResponse;', start);
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

describe('cold start auth recovery boundary', () => {
  it('只有传输层失败接入自动恢复，确定性失效仍清凭证', () => {
    const body = coldStartFailureBranch();
    expect(body).toContain('if (refreshResult.status === 0) {');
    expect(body).toContain('scheduleColdStartNetworkRecovery(authStateEpoch);');
    expect(body).toContain("action.kind === 'definitive-failure'");
    expect(body).toContain('clearConfirmedDeadRefreshTokens(');
    // 自动恢复只挂在 else 分支里，definitive / foreign-device 分支不得触发。
    expect(body.indexOf("action.kind === 'definitive-failure'")).toBeLessThan(
      body.indexOf('scheduleColdStartNetworkRecovery(authStateEpoch);'),
    );
  });

  it('恢复调度重跑完整 initialize，并按登录代次与登录态收口', () => {
    const body = recoveryScheduler();
    expect(authSource).toContain('return initialize().then(');
    expect(body).toContain('retry: retryColdStartAuthSession');
    expect(body).toContain('isCurrent: () => authStateEpoch === epoch');
    expect(body).toContain("getActiveAppSession().mode === 'signed-out'");
  });

  it('整条恢复链每进程只启动一次，登出时取消', () => {
    const body = recoveryScheduler();
    expect(body).toContain('if (coldStartNetworkRecoveryStarted) return;');
    expect(body).toContain('coldStartNetworkRecoveryStarted = true;');

    const start = authSource.indexOf('function clearAuth(');
    const end = authSource.indexOf('if (!opts.preservePersistedRefreshToken)', start);
    const clearBody = authSource.slice(start, end);
    expect(clearBody).toContain('coldStartNetworkRecovery?.cancel();');
    expect(clearBody).toContain('coldStartNetworkRecoveryStarted = false;');
  });
});

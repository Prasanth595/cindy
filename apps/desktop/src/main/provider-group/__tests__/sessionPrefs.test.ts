/**
 * 任务级换号偏好的本机存储(provider-groups.md §6.2)：「以后自动换」与「这一轮不再提醒」互斥、后写覆盖先写，
 * 暂不提醒到期失效，旧版本只有 autoRebalance 的文件照常读。读写走真文件(临时目录)，因为互斥与清洗都在存储层。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-session-prefs-test-'));
let owner = 'owner-a';

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, owner, name),
  activeOwnerScopeKey: () => owner,
  isAppSessionBoundaryPending: () => false,
}));

const prefs = await import('../sessionPrefs.js');
const file = () => path.join(tmpDir, owner, 'provider-group-session-prefs.json');

let n = 0;
beforeEach(() => {
  // 每个用例一个新账号目录：互不影响，也覆盖「换账号后按新路径读」。
  owner = `owner-${++n}`;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
});
afterAll(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

describe('provider group session prefs', () => {
  it('keeps the later of “switch automatically” and “snooze” for a task', async () => {
    await prefs.writeProviderGroupAutoRebalance('s1', 1_000);
    await prefs.writeProviderGroupRebalanceSnooze('s1', 50_000, 2_000);
    expect(prefs.readProviderGroupAutoRebalance('s1')).toBe(false);
    expect(prefs.readProviderGroupRebalanceSnoozed('s1', 3_000)).toBe(true);

    await prefs.writeProviderGroupAutoRebalance('s1', 4_000);
    expect(prefs.readProviderGroupAutoRebalance('s1')).toBe(true);
    expect(prefs.readProviderGroupRebalanceSnoozed('s1', 4_000)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(saved.autoRebalance).toEqual({ s1: 4_000 });
    expect(saved.snoozeRebalance ?? {}).toEqual({});
  });

  it('ends a snooze at its time, drops expired ones on the next write and ignores past times', async () => {
    await prefs.writeProviderGroupRebalanceSnooze('s1', 10_000, 1_000);
    expect(prefs.readProviderGroupRebalanceSnoozed('s1', 9_999)).toBe(true);
    expect(prefs.readProviderGroupRebalanceSnoozed('s1', 10_000)).toBe(false);
    await prefs.writeProviderGroupRebalanceSnooze('s2', 30_000, 20_000);
    await prefs.writeProviderGroupRebalanceSnooze('s3', 5_000, 20_000);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).snoozeRebalance).toEqual({ s2: { at: 20_000, until: 30_000 } });
  });

  // review #6810：旧版本不认识 snoozeRebalance 但会原样保留，在旧版本上勾的「以后自动换」不能被更早的关掉压住。
  it('lets the later choice win when an older version left both on disk', () => {
    fs.writeFileSync(file(), JSON.stringify({
      autoRebalance: { later: 5_000, earlier: 1_000 },
      snoozeRebalance: { later: { at: 2_000, until: 90_000 }, earlier: { at: 3_000, until: 90_000 } },
    }));
    expect(prefs.readProviderGroupAutoRebalance('later')).toBe(true);
    expect(prefs.readProviderGroupRebalanceSnoozed('later', 10_000)).toBe(false);
    expect(prefs.readProviderGroupAutoRebalance('earlier')).toBe(false);
    expect(prefs.readProviderGroupRebalanceSnoozed('earlier', 10_000)).toBe(true);
  });

  it('reads a file written before snoozing existed', async () => {
    fs.writeFileSync(file(), JSON.stringify({ autoRebalance: { old: 1 } }));
    expect(prefs.readProviderGroupAutoRebalance('old')).toBe(true);
    expect(prefs.readProviderGroupRebalanceSnoozed('old', 2)).toBe(false);
    await prefs.writeProviderGroupRebalanceSnooze('old', 100, 2);
    expect(prefs.readProviderGroupAutoRebalance('old')).toBe(false);
    expect(prefs.readProviderGroupRebalanceSnoozed('old', 3)).toBe(true);
  });
});

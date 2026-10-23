/**
 * 任务级的供应商组偏好(docs/product-rules/provider-groups.md §6.2「任务进行中换号」)：
 * - 「以后自动换」：2026-10-21 版换号弹窗里勾过的任务，之后用户自己发消息前直接换。现在由组设置里的开关代替，
 *   旧记录与旧手机发来的 `remember: true` 仍照常生效。
 * - 「暂不提醒」：用户关掉了输入框上方的换号提示，这个任务到这一轮配额重置前不再提议换号。
 * 只对那一个任务有效，两者互斥，后选的覆盖先选的。
 *
 * 记在任务所在电脑上(发送前的检查在这里跑)，按账号存放，跨重启保留：
 * `userData/owners/<账号>/provider-group-session-prefs.json`，只有任务 id 与时间，不含消息、凭证或用户身份。
 * 每种超出容量时淘汰最早的。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

interface SessionPrefsFile {
  /** 任务 id → 打开「以后自动换」的时间(unix ms)。 */
  autoRebalance: Record<string, number>;
  /**
   * 任务 id → 换号提示暂不出现到 `until`，`at` 是关掉的时间(unix ms)。旧版本不认识这个字段但会原样保留，之后在旧版本上
   * 勾「以后自动换」时两边都在，按时间先后取后选的那个。
   */
  snoozeRebalance: Record<string, Snooze>;
}

interface Snooze {
  at: number;
  until: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_PROVIDER_GROUP_SESSION_PREFS = 4000;

function prune(sessions: Record<string, number>): Record<string, number> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_PROVIDER_GROUP_SESSION_PREFS) return sessions;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_PROVIDER_GROUP_SESSION_PREFS));
}

function normalizeSessions(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [sessionId, at] of Object.entries(value)) {
      if (SESSION_ID_PATTERN.test(sessionId) && typeof at === 'number' && Number.isFinite(at) && at > 0) out[sessionId] = at;
    }
  }
  return prune(out);
}

function normalizeSnoozes(value: unknown): Record<string, Snooze> {
  const out: Record<string, Snooze> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [sessionId, entry] of Object.entries(value)) {
      const { at, until } = (entry ?? {}) as Partial<Snooze>;
      if (SESSION_ID_PATTERN.test(sessionId) && typeof at === 'number' && Number.isFinite(at) && at > 0
        && typeof until === 'number' && Number.isFinite(until) && until > at) out[sessionId] = { at, until };
    }
  }
  return pruneSnoozes(out);
}

function pruneSnoozes(sessions: Record<string, Snooze>): Record<string, Snooze> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_PROVIDER_GROUP_SESSION_PREFS) return sessions;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_PROVIDER_GROUP_SESSION_PREFS));
}

function normalize(raw: unknown): SessionPrefsFile {
  const value = raw as Partial<SessionPrefsFile> | null;
  return { autoRebalance: normalizeSessions(value?.autoRebalance), snoozeRebalance: normalizeSnoozes(value?.snoozeRebalance) };
}

function without<T>(sessions: Record<string, T>, sessionId: string): Record<string, T> {
  if (sessions[sessionId] === undefined) return sessions;
  const rest = { ...sessions };
  delete rest[sessionId];
  return rest;
}

/** 去掉已经到期的暂不提醒，文件不会因为关过提示的任务一直变大。 */
function unexpired(sessions: Record<string, Snooze>, now: number): Record<string, Snooze> {
  return Object.fromEntries(Object.entries(sessions).filter(([, snooze]) => snooze.until > now));
}

/** 两个都在(旧版本写过)时取后选的：关掉提示晚于勾自动换时算暂不提醒，否则算自动换。 */
function snoozeWins(value: SessionPrefsFile, sessionId: string): boolean {
  const snooze = value.snoozeRebalance[sessionId];
  const auto = value.autoRebalance[sessionId];
  return snooze !== undefined && (auto === undefined || snooze.at > auto);
}

const store = createOverrideSettingsFile<SessionPrefsFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-session-prefs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { autoRebalance: {}, snoozeRebalance: {} },
  normalize,
  log: desktopMakerLogger.child('provider-group-session-prefs'),
  label: 'provider-group-session-prefs',
  maxBytes: 512 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

/** 这个任务选过「以后自动换，不再询问」。 */
export function readProviderGroupAutoRebalance(sessionId: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  store.invalidateIfChanged();
  const value = store.read();
  return value.autoRebalance[sessionId] !== undefined && !snoozeWins(value, sessionId);
}

/** 记下这个任务以后自动换号(同时撤掉暂不提醒)。 */
export async function writeProviderGroupAutoRebalance(sessionId: string, now: number = Date.now()): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  await store.updateAtomic(({ value }) => ({
    autoRebalance: prune({ ...value.autoRebalance, [sessionId]: now }),
    snoozeRebalance: without(value.snoozeRebalance, sessionId),
  }));
}

/** 这个任务的换号提示此刻处于暂不提醒。 */
export function readProviderGroupRebalanceSnoozed(sessionId: string, now: number = Date.now()): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  store.invalidateIfChanged();
  const value = store.read();
  return snoozeWins(value, sessionId) && value.snoozeRebalance[sessionId].until > now;
}

/** 这个任务的换号提示暂不出现到 `until`(同时撤掉「以后自动换」)。 */
export async function writeProviderGroupRebalanceSnooze(sessionId: string, until: number, now: number = Date.now()): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !(until > now)) return;
  await store.updateAtomic(({ value }) => ({
    autoRebalance: without(value.autoRebalance, sessionId),
    snoozeRebalance: pruneSnoozes({ ...unexpired(value.snoozeRebalance, now), [sessionId]: { at: now, until } }),
  }));
}

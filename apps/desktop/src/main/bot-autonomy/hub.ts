/**
 * 伙伴自主跟进 · 轻量入口（hub）。
 *
 * 输入协调器（register）、伙伴 IPC（bots.ts）只经这里读写，不直接 import 带设备互联 / 通知 /
 * 灵动岛依赖的 service.ts；运行体由 service.ts 在例行任务引擎启动后挂进来。
 */
import type { BrowserWindow } from 'electron';
import type { RoutineEngine } from '@cindy/maker-scheduler';

import {
  DEFAULT_SCHEDULER_BOT_ID,
  type BotAutonomySettingsView,
  type BotGlance,
} from '../../shared/botAutonomy.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  readBotAutonomySettingsOverride,
  resetBotAutonomySettings,
  writeBotAutonomySchedulerBotId,
} from '../maker-host/bot-autonomy-settings-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { resolveSchedulerBotId } from './follower.js';
import { readBotDirectory } from './hostData.js';
import type { BotAutonomyRuntime, GlanceOptions } from './runtime.js';
import { errorCode } from './taskWatch.js';

const log = createLogger('bot-autonomy');

export interface BotAutonomyHostDeps {
  /** 某个本机任务当前挂起的交互请求（只读）。 */
  getPendingInteractions(sessionId: string): readonly unknown[];
  getMainWindow(): BrowserWindow | null;
}

let hostDeps: Partial<BotAutonomyHostDeps> = {};
let current: { scope: string; engine: RoutineEngine; runtime: BotAutonomyRuntime } | null = null;

/** 各宿主模块分别补自己持有的入口（register 给挂起交互，bootstrap 给主窗口）。 */
export function configureBotAutonomyHost(deps: Partial<BotAutonomyHostDeps>): void {
  hostDeps = { ...hostDeps, ...deps };
}

export function getBotAutonomyHostDeps(): Partial<BotAutonomyHostDeps> {
  return hostDeps;
}

export function getActiveBotAutonomy(): typeof current {
  return current;
}

export function setActiveBotAutonomy(next: typeof current): void {
  current = next;
}

export function scopeIsCurrent(scope: string): boolean {
  return !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope;
}

/** 输入协调器投影（出错 / 用量上限等待）旁路进状态表。 */
export function noteBotAutonomyInputProjection(projection: unknown): void {
  const runtime = current?.runtime;
  if (!runtime || !projection || typeof projection !== 'object') return;
  runtime.watch.applyInputProjection(projection as { sessionId: string; error?: string | null; usageLimitWait?: unknown });
}

function emptyGlance(botId: string): BotGlance {
  return { botId, scope: 'own', waiting: [], working: [], lastSweepAt: 0, doneToday: 0, offlineDevices: [] };
}

export function getBotAutonomyGlance(botId: string, options?: GlanceOptions): BotGlance {
  if (isAppSessionBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'App session is switching; retry later.');
  const active = current && scopeIsCurrent(current.scope) ? current.runtime : null;
  return active ? active.glance(botId, options) : emptyGlance(botId);
}

/** 默认总调度：在用的 Cindy 助理，否则没有。 */
function defaultSchedulerBotId(bots: ReadonlyMap<string, { status: string }>): string | null {
  return bots.get(DEFAULT_SCHEDULER_BOT_ID)?.status === 'active' ? DEFAULT_SCHEDULER_BOT_ID : null;
}

export async function getBotAutonomySettingsView(): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  const bots = await readBotDirectory();
  assertOwner(scope);
  const override = readBotAutonomySettingsOverride();
  return {
    schedulerBotId: resolveSchedulerBotId(override, bots),
    isCustomized: override.customized,
    defaults: { schedulerBotId: defaultSchedulerBotId(bots) },
  };
}

function assertOwner(scope: string): void {
  if (!scopeIsCurrent(scope)) throwIpcError('PRECONDITION_FAILED', 'App session changed; retry in the current account.');
}

/** 设置「自动跟进所有任务」归谁；null = 关闭。目标伙伴必须存在且没被归档。 */
export async function setBotAutonomySchedulerBotId(schedulerBotId: string | null): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  assertOwner(scope);
  if (schedulerBotId !== null) {
    const bots = await readBotDirectory();
    assertOwner(scope);
    const bot = bots.get(schedulerBotId);
    if (!bot || bot.status === 'archived' || bot.status === 'deleting') throwIpcError('NOT_FOUND', 'Teammate not found');
  }
  await writeBotAutonomySchedulerBotId(schedulerBotId);
  return afterSettingsChange(scope);
}

/** 删除 override，跟随当前版本默认。 */
export async function resetBotAutonomySchedulerSettings(): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  assertOwner(scope);
  await resetBotAutonomySettings();
  return afterSettingsChange(scope);
}

async function afterSettingsChange(scope: string): Promise<BotAutonomySettingsView> {
  assertOwner(scope);
  const runtime = current && current.scope === scope ? current.runtime : null;
  if (runtime) await runtime.refreshFollowers().catch((error) => log.warn('autonomy refresh failed', { error: errorCode(error) }));
  log.info('autonomy scheduler setting changed');
  return getBotAutonomySettingsView();
}

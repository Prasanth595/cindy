/**
 * macOS menu bar quota item: collects usage, builds the view and drives the native helper.
 *
 * Rebuilds are debounced and coalesced. They run on usage broadcasts, running-task
 * transitions, settings and locale changes and a slow timer. Opening the panel or pressing
 * refresh also asks every subscription reader to refresh, so values catch up while the
 * panel is on screen. Everything here reads caches Cindy already keeps; the only extra
 * network call is the Cindy balance, which is fetched at most once a minute.
 */

import { app, Notification } from 'electron';
import os from 'node:os';

import { isSessionActivityRunning } from '@cindy/maker-shared/session-activity';

import type { ModelAccessCreditUsage } from '../../shared/modelAccess.js';
import {
  isMenubarSupportedPlatform,
  type MenubarHelperMessage,
  type MenubarSettings,
  type MenubarSettingsPatch,
  type MenubarState,
  type MenubarUsageScope,
  type MenubarView,
} from '../../shared/menubarQuota.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getAppCapabilities } from '../appCapabilities.js';
import * as authManager from '../authManager.js';
import { projectModelAccessBalance, projectModelAccessCreditUsage } from '../billing/projection.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import {
  focusMainWindow,
  openMainWindowBillingTopUp,
  openMainWindowSession,
  openMainWindowVoiceSettings,
} from '../deepLink.js';
import { deviceName } from '../device-link/deviceName.js';
import { getResolvedMainLocale, mainStringKeysUnder, rawMainString } from '../i18n.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { inspectAppDefaultModel } from '../maker-ipc/appDefaultModelControl.js';
import { applyNewMakerDraftRoute } from '../maker-ipc/register.js';
import {
  readClaudeSubscriptionUsageSnapshotForDeviceLink,
  readXaiSubscriptionUsageSnapshotForDeviceLink,
  triggerClaudeSubscriptionUsageRefresh,
  triggerCodexAccountUsageRefresh,
  triggerXaiSubscriptionUsageRefresh,
} from '../maker-ipc/usage.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import { serverApiFetch } from '../serverApiClient.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { readUsageHistory, type UsageHistoryPayload } from '../usage/usageHistory.js';
import { observeUsageChanges, readCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { CreditSampleStore, estimateDailyBurn, largestCreditSample } from './creditSamples.js';
import {
  collectMenubarInputs,
  MENUBAR_USAGE_DAYS,
  type MenubarBalanceReading,
  type MenubarCollected,
} from './collect.js';
import { MacMenubarNativeHost } from './MacMenubarNativeHost.js';
import { MENUBAR_HARNESS_LOGOS } from './logos.js';
import { readMenubarSettings, writeMenubarSettings } from './settingsStore.js';
import { buildMenubarView, isLowOnEverything, type MenubarBuildInput } from './snapshot.js';
import { buildMenubarUiStrings, createMenubarTranslate } from './strings.js';

const log = createLogger('menubar');

const REBUILD_DEBOUNCE_MS = 400;
const PERIODIC_REBUILD_MS = 5 * 60_000;
/** A usage payload marked stale is being re-aggregated; look again shortly. */
const STALE_FOLLOW_UP_MS = 3_000;
const STALE_FOLLOW_UP_MAX = 5;
const BALANCE_FRESH_WHILE_OPEN_MS = 60_000;
const BALANCE_FRESH_WHILE_CLOSED_MS = 10 * 60_000;
const BALANCE_TIMEOUT_MS = 20_000;
/**
 * Usage history keeps a single cache slot, and the two device ranges evict each other, so
 * every read recomputes the history. Re-read on this cadence instead of on every token tick.
 */
const USAGE_FRESH_WHILE_OPEN_MS = 30_000;
const USAGE_FRESH_WHILE_CLOSED_MS = 5 * 60_000;

export interface MenubarServiceDeps {
  /** Opens a new task in the main window (the app menu's "New Task" command). */
  openNewTask(): void;
  /** Quits the app, confirming first while a task turn is running. */
  quit(): void;
}

interface UsageCacheEntry {
  payload: UsageHistoryPayload;
  readAtMs: number;
}

interface BalanceCache {
  /** Account the reading belongs to; a different signed-in user invalidates it. */
  accountKey: string;
  reading: MenubarBalanceReading | null;
  fetchedAtMs: number;
}

class MenubarService {
  private readonly host: MacMenubarNativeHost;
  private readonly creditSamples = new CreditSampleStore();
  private settings: MenubarSettings;
  private started = false;
  private panelOpen = false;
  private lastView: MenubarView | null = null;
  /** Null until the first build, so launching while low does not notify. */
  private wasLow: boolean | null = null;
  private lowNotification: Notification | null = null;
  private balance: BalanceCache | null = null;
  private balanceInFlight: Promise<MenubarBalanceReading | null> | null = null;
  private readonly usageCache = new Map<MenubarUsageScope, UsageCacheEntry>();
  private usageUserId: string | null = null;
  /** Serializes history reads so the two ranges never recompute at the same time. */
  private usageChain: Promise<unknown> = Promise.resolve();

  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private building = false;
  private rebuildQueued = false;
  private forceNext = false;
  private staleFollowUps = 0;
  private disposers: (() => void)[] = [];

  constructor(private readonly deps: MenubarServiceDeps) {
    this.settings = readMenubarSettings();
    this.host = new MacMenubarNativeHost({ onMessage: (message) => this.handleHelperMessage(message) });
  }

  get state(): MenubarState {
    return { available: true, enabled: this.settings.enabled };
  }

  init(): void {
    if (this.settings.enabled) this.start();
  }

  setEnabled(enabled: boolean): MenubarState {
    this.settings = writeMenubarSettings({ enabled });
    if (enabled) this.start();
    else this.halt();
    return this.state;
  }

  refreshLocalization(): void {
    if (this.started) this.scheduleRebuild(0);
  }

  /** Opens the panel under the status item. */
  openPanel(): void {
    if (!this.started) return;
    this.host.open();
  }

  stop(): void {
    this.halt();
    this.host.stop();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.wasLow = null;
    this.usageUserId = authManager.getAuthState().user?.id ?? null;
    this.host.resetFailure();
    this.host.prepare();
    this.disposers.push(
      observeUsageChanges(() => this.scheduleRebuild()),
      authManager.onAuthStateChange((state) => {
        if (!state.isAuthenticated) this.balance = null;
        // Usage history belongs to the signed-in account; token refreshes keep the cache.
        const userId = state.isAuthenticated ? state.user?.id ?? null : null;
        if (userId !== this.usageUserId) {
          this.usageUserId = userId;
          this.usageCache.clear();
        }
        this.scheduleRebuild();
      }),
    );
    const island = getAgentIslandService();
    if (island) {
      this.disposers.push(
        island.subscribeSessionActivity(({ previous, current }) => {
          const wasRunning = previous ? isSessionActivityRunning(previous) : false;
          const isRunning = current ? isSessionActivityRunning(current) : false;
          if (wasRunning !== isRunning) this.scheduleRebuild();
        }),
      );
    }
    this.periodicTimer = setInterval(() => this.scheduleRebuild(), PERIODIC_REBUILD_MS);
    this.scheduleRebuild(0);
  }

  private halt(): void {
    if (!this.started) return;
    this.started = false;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Listener already gone.
      }
    }
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.panelOpen = false;
    this.lastView = null;
    this.usageCache.clear();
    this.lowNotification?.close();
    this.lowNotification = null;
    this.host.suspend();
  }

  private scheduleRebuild(delayMs = REBUILD_DEBOUNCE_MS, force = false): void {
    if (!this.started) return;
    if (force) this.forceNext = true;
    if (this.building) {
      this.rebuildQueued = true;
      return;
    }
    if (this.rebuildTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild();
    }, delayMs);
  }

  private async rebuild(): Promise<void> {
    if (!this.started || this.building) return;
    this.building = true;
    const force = this.forceNext;
    this.forceNext = false;
    let stale = false;
    try {
      const nowMs = Date.now();
      const collected = await collectMenubarInputs({
        nowMs,
        listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
        readCodex: (providerId) => readCodexAccountUsageSnapshot(providerId),
        readClaude: (providerId) => readClaudeSubscriptionUsageSnapshotForDeviceLink(providerId),
        readXai: (providerId) => readXaiSubscriptionUsageSnapshotForDeviceLink(providerId),
        readBalance: () => this.readBalance(force, nowMs),
        readUsage: async (scope: MenubarUsageScope) => {
          const payload = await this.readUsage(scope, force, nowMs);
          if (payload.stale) stale = true;
          return payload;
        },
        activities: () => getAgentIslandService()?.getSessionActivitySnapshots() ?? [],
        sessionRow: async (sessionId) => {
          const row = await getSessionRowSnapshot(sessionId);
          return row ? { title: row.title, model: row.model ?? null, agentKind: row.agentKind ?? null } : null;
        },
        selfDeviceName: deviceName(),
        onError: (scope, error) => log.warn('menu bar source failed', { scope, error: errorMessage(error) }),
      });
      if (!this.started) return;
      this.publish(collected, nowMs);
    } catch (error) {
      log.warn('menu bar rebuild failed', { error: errorMessage(error) });
    } finally {
      this.building = false;
    }
    if (stale && this.staleFollowUps < STALE_FOLLOW_UP_MAX) {
      this.staleFollowUps += 1;
      this.scheduleRebuild(STALE_FOLLOW_UP_MS);
    } else if (!stale) {
      this.staleFollowUps = 0;
    }
    if (this.rebuildQueued) {
      this.rebuildQueued = false;
      this.scheduleRebuild();
    }
  }

  /** Cached usage history; a stale payload is re-read on the next build. */
  private async readUsage(scope: MenubarUsageScope, force: boolean, nowMs: number): Promise<UsageHistoryPayload> {
    const cached = this.usageCache.get(scope);
    const maxAge = this.panelOpen ? USAGE_FRESH_WHILE_OPEN_MS : USAGE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && !cached.payload.stale && nowMs - cached.readAtMs < maxAge) return cached.payload;
    const read = this.usageChain.then(() =>
      readUsageHistory({
        days: MENUBAR_USAGE_DAYS,
        modelDays: MENUBAR_USAGE_DAYS,
        device: scope,
        includeTasks: scope === 'local',
        ...(force ? { forceRefresh: true } : {}),
      }),
    );
    this.usageChain = read.catch(() => undefined);
    const payload = await read;
    this.usageCache.set(scope, { payload, readAtMs: Date.now() });
    return payload;
  }

  private publish(collected: MenubarCollected, nowMs: number): void {
    const locale = getResolvedMainLocale();
    const raw = (key: string) => rawMainString(key, locale);
    const input: MenubarBuildInput = {
      nowMs,
      locale,
      moneySymbol: currentLedgerCurrency() === 'CNY' ? '¥' : '$',
      settings: this.settings,
      sources: collected.sources,
      tasks: collected.tasks,
      usage: collected.usage,
      updatedAtMs: collected.updatedAtMs,
      harnessLogos: MENUBAR_HARNESS_LOGOS,
      uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
      t: createMenubarTranslate(locale, raw),
    };
    const view = buildMenubarView(input);
    this.lastView = view;
    this.host.publish(view);
    this.updateLowAlert(isLowOnEverything(input), input);
  }

  // ── Low alert ──────────────────────────────────────────────────────────────

  /** Notifies once when everything usable drops to nearly empty; never on the first build. */
  private updateLowAlert(low: boolean, input: MenubarBuildInput): void {
    const previous = this.wasLow;
    this.wasLow = low;
    if (!low) {
      this.lowNotification?.close();
      this.lowNotification = null;
      return;
    }
    if (previous !== false || !this.settings.lowAlert || !getDesktopNotificationsEnabled()) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: input.t('notify.lowTitle'),
      body: input.t('notify.lowBody'),
    });
    this.lowNotification = notification;
    const release = () => {
      if (this.lowNotification === notification) this.lowNotification = null;
    };
    notification.on('click', () => {
      release();
      this.openPanel();
    });
    notification.on('close', release);
    notification.on('failed', (_event, error) => {
      log.warn('menu bar low alert failed', { error: String(error) });
      release();
    });
    notification.show();
  }

  // ── Cindy balance ──────────────────────────────────────────────────────────

  private balanceAccountKey(): string | null {
    if (!getAppCapabilities().canUseCindyAccountServices) return null;
    const user = authManager.getAuthState().user;
    if (!user || user.membershipKind !== 'personal') return null;
    return `${user.id}:${CURRENT_CINDY_REGION}`;
  }

  private async readBalance(force: boolean, nowMs: number): Promise<MenubarBalanceReading | null> {
    const accountKey = this.balanceAccountKey();
    if (!accountKey) {
      this.balance = null;
      return null;
    }
    const cached = this.balance?.accountKey === accountKey ? this.balance : null;
    const maxAge = this.panelOpen ? BALANCE_FRESH_WHILE_OPEN_MS : BALANCE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.fetchedAtMs < maxAge) return cached.reading;
    if (!this.balanceInFlight) {
      this.balanceInFlight = this.fetchBalance().finally(() => {
        this.balanceInFlight = null;
      });
    }
    try {
      const reading = await this.balanceInFlight;
      // A sign-out or account switch while the request was out drops the result.
      if (this.balanceAccountKey() !== accountKey) return null;
      this.balance = { accountKey, reading, fetchedAtMs: Date.now() };
      return reading;
    } catch (error) {
      log.warn('menu bar balance read failed', { error: errorMessage(error) });
      // Keep showing the last known amount; its "updated" time tells the age.
      return cached?.reading ?? null;
    }
  }

  private async fetchBalance(): Promise<MenubarBalanceReading | null> {
    const baseUrl = () => getClientEndpoint('modelAccessApiBaseUrl');
    const options = { timeoutMs: BALANCE_TIMEOUT_MS, redactErrorDetails: true, baseUrl };
    let available: number;
    let pools: number | null = null;
    let observedAt: string;
    try {
      const usage: ModelAccessCreditUsage = projectModelAccessCreditUsage(
        await serverApiFetch<unknown>('/api/model-access/credit-usage', options),
      );
      available = Number(usage.available);
      observedAt = usage.observedAt;
      const totals = [usage.plan.total, usage.purchased.total, usage.promotional.total];
      if (totals.every((total) => total !== null)) {
        pools = totals.reduce((sum, total) => sum + Number(total), 0);
      }
    } catch (error) {
      log.info('credit usage unavailable, falling back to balance', { error: errorMessage(error) });
      const balance = projectModelAccessBalance(await serverApiFetch<unknown>('/api/model-access/balance', options));
      available = Number(balance.available);
      observedAt = balance.observedAt;
    }
    if (!Number.isFinite(available)) return null;
    const observedAtMs = Date.parse(observedAt);
    const atMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    const currency = CURRENT_CINDY_REGION === 'global' ? 'USD' : 'CNY';
    const samples = this.creditSamples.record(`${CURRENT_CINDY_REGION}:${currency}`, available, atMs);
    const largest = largestCreditSample(samples);
    const fullAmount = pools !== null && Number.isFinite(pools) && pools > 0 ? pools : largest;
    return {
      available,
      fullAmount: fullAmount !== null && fullAmount >= available ? fullAmount : available,
      burnPerDay: estimateDailyBurn(samples, atMs),
      observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
      currency,
    };
  }

  // ── Helper messages ────────────────────────────────────────────────────────

  private handleHelperMessage(message: MenubarHelperMessage): void {
    switch (message.type) {
      case 'ready':
      case 'error':
        return;
      case 'panel':
        this.panelOpen = message.open;
        if (message.open) this.refreshSources(false);
        return;
      case 'refresh':
        this.refreshSources(true);
        return;
      case 'open-app':
        this.showMainWindow();
        return;
      case 'open-session':
        openMainWindowSession(message.sessionId);
        return;
      case 'detail-action':
        void this.runDetailAction(message.sourceId);
        return;
      case 'open-provider-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'settings':
        this.applySettingsPatch(message.patch);
        return;
      case 'quit':
        this.deps.quit();
        return;
    }
  }

  private applySettingsPatch(patch: MenubarSettingsPatch): void {
    this.settings = writeMenubarSettings(patch);
    if (!this.settings.enabled) {
      this.halt();
      return;
    }
    this.scheduleRebuild(0);
  }

  /** Asks every subscription reader to refresh; their broadcasts trigger the rebuild. */
  private refreshSources(force: boolean): void {
    void getDesktopProviderService()
      .listProviders({ allowSideEffects: false })
      .then((providers) => {
        for (const provider of providers) {
          if (!provider.connected || provider.suspended || provider.removed) continue;
          const kind = providerWeeklyQuotaSource(provider);
          if (kind === 'codex') triggerCodexAccountUsageRefresh(provider.id);
          else if (kind === 'claude') triggerClaudeSubscriptionUsageRefresh(provider.id);
          else if (kind === 'xai') triggerXaiSubscriptionUsageRefresh(provider.id);
        }
      })
      .catch((error) => log.warn('menu bar refresh could not list providers', { error: errorMessage(error) }));
    this.scheduleRebuild(0, force);
  }

  private showMainWindow(): void {
    if (!focusMainWindow()) app.focus({ steal: true });
  }

  private async runDetailAction(sourceId: string): Promise<void> {
    const action = this.lastView?.details[sourceId]?.action;
    if (!action) return;
    switch (action.kind) {
      case 'new-task':
        await this.openTaskWith(action.providerId);
        return;
      case 'open-billing':
        openMainWindowBillingTopUp();
        return;
      case 'open-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'none':
        return;
    }
  }

  /** New task preselected on this account: the default model when it already uses it. */
  private async openTaskWith(providerId: string): Promise<void> {
    try {
      const { current, available } = await inspectAppDefaultModel();
      const route = current && current.providerId === providerId
        ? current
        : available.find((option) => option.route.providerId === providerId)?.route ?? null;
      if (route) applyNewMakerDraftRoute(route);
      else log.info('no model available for menu bar task', { providerId });
    } catch (error) {
      log.warn('menu bar could not preselect a model', { error: errorMessage(error) });
    }
    this.deps.openNewTask();
  }
}

let service: MenubarService | null = null;

export function initMenubarService(deps: MenubarServiceDeps): void {
  if (service || !isMenubarSupportedPlatform(process.platform, os.release())) return;
  service = new MenubarService(deps);
  service.init();
}

export function getMenubarState(): MenubarState {
  return service?.state ?? { available: false, enabled: false };
}

export function setMenubarEnabled(enabled: boolean): MenubarState {
  return service ? service.setEnabled(enabled) : { available: false, enabled: false };
}

export function refreshMenubarLocalization(): void {
  service?.refreshLocalization();
}

export function stopMenubarService(): void {
  service?.stop();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

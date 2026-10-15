/**
 * GhostOverlayWindowsController —— 插件桌面浮窗(ghost overlay window)的生命周期
 * 状态机(main 侧单例,依赖注入可测)。
 *
 * 每 ghostId 一扇透明置顶浮窗,没有窗口级持久状态(位置不持久化,重启即重置)。
 * 生命周期基线对齐 ghost-panel-window/controller.ts:
 *   - 惰性预热:prewarm/show 时按需创建隐藏窗口并加载 renderer
 *   - 双阶段就绪握手(renderer-ready → presentation-ready),5s 超时展示壳
 *   - 隐藏复用:普通隐藏只 hide,不销毁;下次 show 复用同一 Renderer
 *   - 不抢焦点:展示一律走 showInactive(),浮窗永不 focus
 *   - 崩溃恢复有界(每 ghostId 独立计数,稳定 30s 后恢复额度)
 *   - 多 ghostId 实例间状态隔离
 *   - reconcile:插件卸载/停用/失去 overlay 声明时 dispose 对应浮窗
 *   - owner 切换收口:disposeAllForOwnerChange() 销毁全部浮窗
 */

import type { BrowserWindow, WebContents } from 'electron';

import type {
  GhostOverlayWindowEntryState,
  GhostOverlayWindowsState,
} from '../../shared/ghostOverlayWindow.js';
import { GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL } from '../../shared/ghostOverlayWindow.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { Logger } from '../logger.js';
import { clearGhostOverlayWebContents } from './registry.js';

export interface GhostOverlayWindowsControllerDeps {
  createWindow: (ghostId: string) => Promise<BrowserWindow>;
  isGhostOverlayDeclared: (ghostId: string) => boolean;
  isUserEnabled: (ghostId: string) => boolean;
  broadcastState: (state: GhostOverlayWindowsState) => void;
  isQuitting: () => boolean;
  log: Logger;
}

const DEFAULT_SHOW_TIMEOUT_MS = 5000;
const DEFAULT_RECOVERY_STABILITY_MS = 30_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;

interface WindowSlot {
  win: BrowserWindow;
  /** 创建时捕获,销毁后仍可用于清理 registry 绑定。 */
  webContentsId: number;
  rendererReady: boolean;
  presentationReady: boolean;
  visible: boolean;
  interactive: boolean;
  pendingShow: boolean;
  destroyingWindow: boolean;
  showTimeout: NodeJS.Timeout | null;
  recoveryStabilityTimeout: NodeJS.Timeout | null;
  automaticRecoveryAttempts: number;
}

export class GhostOverlayWindowsController {
  private readonly slots = new Map<string, WindowSlot>();
  /** 在途创建去重:同一 ghostId 只允许一个 createWindow 在飞。 */
  private readonly pendingCreates = new Map<string, Promise<WindowSlot | null>>();
  private disposed = false;
  /** 销毁代次:disposeAllForOwnerChange/dispose 后作废在途创建。 */
  private generation = 0;

  constructor(private readonly deps: GhostOverlayWindowsControllerDeps) {}

  // ══════════════════════════════════════════════════════════════════════
  // 公共接口
  // ══════════════════════════════════════════════════════════════════════

  getState(): GhostOverlayWindowsState {
    const out: GhostOverlayWindowsState = {};
    for (const [id, slot] of this.slots) {
      out[id] = this.entryState(slot);
    }
    return out;
  }

  /**
   * 后台预热指定 ghostId:创建隐藏窗口并加载 renderer,不展示、不改变焦点。
   * 幂等;用户禁用时拒绝(fail closed)。
   */
  prewarm(ghostId: string): void {
    if (this.disposed) return;
    if (!this.deps.isGhostOverlayDeclared(ghostId)) return;
    if (!this.deps.isUserEnabled(ghostId)) {
      this.deps.log.warn('ghost overlay prewarm refused (user disabled)', { ghostId });
      return;
    }
    void this.ensureSlot(ghostId);
  }

  /**
   * 幂等展示:双阶段就绪后 showInactive()(不抢焦点);冷窗口等待首份内容,
   * 5s 超时只展示已挂载壳,不展示空白。用户禁用时拒绝(fail closed)。
   */
  async show(ghostId: string): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.isGhostOverlayDeclared(ghostId)) {
      this.deps.log.warn('ghost overlay not declared, pruning slot', { ghostId });
      const stale = this.slots.get(ghostId);
      if (stale && !stale.destroyingWindow) this.disposeSlot(ghostId, stale);
      this.broadcast();
      return;
    }
    if (!this.deps.isUserEnabled(ghostId)) {
      this.deps.log.warn('ghost overlay show refused (user disabled)', { ghostId });
      return;
    }

    const slot = await this.ensureSlot(ghostId);
    if (!slot || slot.win.isDestroyed()) return;

    // 已在展示:保持原样,绝不抢焦点。
    if (slot.visible && slot.win.isVisible() && !slot.win.isMinimized()) {
      return;
    }
    if (slot.presentationReady) {
      this.showInactive(slot);
      return;
    }
    slot.pendingShow = true;
    this.scheduleShowFallback(ghostId, slot);
    this.broadcast();
  }

  /** 普通隐藏只 hide(保留 renderer,下次瞬时复用);向浮窗同步可见性。 */
  hide(ghostId: string): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    this.hideWindow(ghostId, slot);
  }

  /** 坐标直通:把浮窗平移到指定屏幕位置。 */
  move(ghostId: string, x: number, y: number): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    slot.win.setPosition(x, y);
  }

  /**
   * 交互态直通:true = 接收鼠标事件;false = 恢复穿透(forward 语义,点击
   * 透传到浮窗下层,窗口自身不抢焦点)。
   */
  setInteractive(ghostId: string, interactive: boolean): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    slot.interactive = interactive;
    if (interactive) {
      slot.win.setIgnoreMouseEvents(false);
    } else {
      slot.win.setIgnoreMouseEvents(true, { forward: true });
    }
    this.broadcast();
  }

  /** 真正销毁指定浮窗并清理 registry。 */
  unmount(ghostId: string): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.destroyingWindow) return;
    this.disposeSlot(ghostId, slot);
    this.broadcast();
  }

  /** 插件卸载/停用/失去 overlay 声明时 dispose 对应浮窗。 */
  reconcile(ghosts: InstalledGhost[]): void {
    const byId = new Map(ghosts.map((g) => [installedGhostStoragePart(g), g]));
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      const ghost = byId.get(id);
      const eligible =
        ghost !== undefined &&
        ghost.enabled !== false &&
        ghost.manifest.overlay !== undefined;
      if (eligible) continue;

      if (!slot.destroyingWindow) {
        this.disposeSlot(id, slot);
        changed = true;
        this.deps.log.info('ghost overlay window reconciled away', { ghostId: id });
      }
    }
    if (changed) this.broadcast();
  }

  /** data owner 切换时销毁全部浮窗(浮窗无持久状态,不落盘)。 */
  disposeAllForOwnerChange(): void {
    this.destroyAllWindows();
    this.broadcast();
  }

  // ── 双阶段就绪 ──────────────────────────────────────────────────────

  markRendererReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    entry.slot.rendererReady = true;
  }

  markPresentationReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    entry.slot.presentationReady = true;
    this.scheduleRecoveryStabilityReset(entry.slot);
    if (entry.slot.pendingShow) {
      this.showInactive(entry.slot);
    }
  }

  /** 查找 sender 对应的 ghostId+slot;非本 controller 管理的窗口返回 null。 */
  slotForSender(sender: WebContents): { ghostId: string; slot: WindowSlot } | null {
    for (const [id, slot] of this.slots) {
      if (slot.win && !slot.win.isDestroyed() && slot.win.webContents === sender) {
        return { ghostId: id, slot };
      }
    }
    return null;
  }

  /** 应用退出/销毁:永久停止并同步销毁所有缓存浮窗。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyAllWindows();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部:窗口创建与生命周期
  // ══════════════════════════════════════════════════════════════════════

  private ensureSlot(ghostId: string): Promise<WindowSlot | null> {
    const existing = this.slots.get(ghostId);
    if (existing && !existing.win.isDestroyed()) return Promise.resolve(existing);

    const inflight = this.pendingCreates.get(ghostId);
    if (inflight) return inflight;

    const generation = this.generation;
    const promise = this.createSlot(ghostId, generation);
    this.pendingCreates.set(ghostId, promise);
    const cleanup = () => {
      if (this.pendingCreates.get(ghostId) === promise) this.pendingCreates.delete(ghostId);
    };
    // fulfillment 与 rejection 都要清理映射:若只在 fulfilled 分支清理,一旦
    // createSlot 意外 reject,该 ghostId 会永久命中已拒绝的 inflight promise。
    // then(cleanup, cleanup) 不改变 promise 的透传语义,也不会新增未处理拒绝。
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async createSlot(ghostId: string, generation: number): Promise<WindowSlot | null> {
    let win: BrowserWindow;
    try {
      win = await this.deps.createWindow(ghostId);
    } catch (error) {
      this.deps.log.warn('ghost overlay window creation failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    // 创建期间退出/销毁换代/资格失效:fail closed,不挂载僵尸窗口。
    if (
      this.disposed ||
      this.deps.isQuitting() ||
      generation !== this.generation ||
      !this.deps.isGhostOverlayDeclared(ghostId) ||
      !this.deps.isUserEnabled(ghostId)
    ) {
      this.disposeAbandonedWindow(win);
      return null;
    }

    const existing = this.slots.get(ghostId);
    if (existing && !existing.win.isDestroyed()) {
      this.disposeAbandonedWindow(win);
      return existing;
    }

    const slot: WindowSlot = {
      win,
      webContentsId: win.webContents.id,
      rendererReady: false,
      presentationReady: false,
      visible: false,
      interactive: false,
      pendingShow: false,
      destroyingWindow: false,
      showTimeout: null,
      recoveryStabilityTimeout: null,
      automaticRecoveryAttempts: 0,
    };
    this.slots.set(ghostId, slot);
    this.attachWindowListeners(ghostId, slot);
    return slot;
  }

  private attachWindowListeners(ghostId: string, slot: WindowSlot): void {
    const { win } = slot;
    win.on('show', () => this.onNativeVisibilityChanged(ghostId, slot, true));
    win.on('hide', () => this.onNativeVisibilityChanged(ghostId, slot, false));
    win.on('closed', () => this.onClosed(ghostId, slot));
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.onRendererReloadStarted(ghostId, slot);
    });
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.invalidateSlot(ghostId, slot, `load failed (${errorCode}): ${errorDescription}`);
        }
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      this.invalidateSlot(ghostId, slot, `renderer process gone: ${details.reason}`);
    });
  }

  private showInactive(slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.pendingShow = false;
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.showInactive();
    slot.visible = true;
    this.sendVisibility(slot, true);
    this.broadcast();
  }

  private hideWindow(ghostId: string, slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.pendingShow = false;
    if (slot.win.isVisible()) slot.win.hide();
    slot.visible = false;
    this.sendVisibility(slot, false);
    this.broadcast();
    this.deps.log.info('ghost overlay window hidden', { ghostId });
  }

  private sendVisibility(slot: WindowSlot, visible: boolean): void {
    try {
      slot.win.webContents.send(GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible });
    } catch {
      // window may be torn down
    }
  }

  private onNativeVisibilityChanged(
    ghostId: string,
    slot: WindowSlot,
    visible: boolean,
  ): void {
    if (
      this.slots.get(ghostId) !== slot ||
      slot.win.isDestroyed() ||
      slot.destroyingWindow ||
      this.disposed
    ) {
      return;
    }
    if (slot.visible === visible && !slot.pendingShow) return;
    slot.visible = visible;
    if (visible) slot.pendingShow = false;
    this.sendVisibility(slot, visible);
    this.broadcast();
  }

  private onClosed(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    clearGhostOverlayWebContents(slot.webContentsId);
    if (this.slots.get(ghostId) !== slot) return;
    this.slots.delete(ghostId);
    if (slot.destroyingWindow) return;
    if (this.deps.isQuitting()) return;
    this.broadcast();
    this.deps.log.info('ghost overlay window closed (destroyed)', { ghostId });
  }

  // ── 超时 ────────────────────────────────────────────────────────────

  private scheduleShowFallback(ghostId: string, slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.showTimeout = setTimeout(() => {
      slot.showTimeout = null;
      if (slot.win.isDestroyed() || !slot.pendingShow) return;
      // 壳(rendererReady)未就绪时展示可能是空白窗口:作废缓存并走有界恢复,
      // 恢复额度耗尽才放弃;壳已就绪则展示已挂载的 Loading 壳。
      if (!slot.rendererReady) {
        this.invalidateSlot(ghostId, slot, 'renderer readiness timed out');
        return;
      }
      if (!slot.visible) this.showInactive(slot);
    }, DEFAULT_SHOW_TIMEOUT_MS);
    slot.showTimeout.unref?.();
  }

  private clearShowTimeout(slot: WindowSlot): void {
    if (!slot.showTimeout) return;
    clearTimeout(slot.showTimeout);
    slot.showTimeout = null;
  }

  private scheduleRecoveryStabilityReset(slot: WindowSlot): void {
    if (slot.automaticRecoveryAttempts === 0) return;
    if (slot.recoveryStabilityTimeout) {
      clearTimeout(slot.recoveryStabilityTimeout);
    }
    slot.recoveryStabilityTimeout = setTimeout(() => {
      slot.recoveryStabilityTimeout = null;
      if (slot.win.isDestroyed() || !slot.presentationReady) return;
      slot.automaticRecoveryAttempts = 0;
    }, DEFAULT_RECOVERY_STABILITY_MS);
    slot.recoveryStabilityTimeout.unref?.();
  }

  // ── 崩溃恢复 ────────────────────────────────────────────────────────

  private onRendererReloadStarted(ghostId: string, slot: WindowSlot): void {
    if (slot.win.isDestroyed()) return;
    const shouldRestore = slot.visible || slot.pendingShow;
    if (shouldRestore) slot.pendingShow = true;
    if (slot.visible) slot.win.hide();
    slot.rendererReady = false;
    slot.presentationReady = false;
    if (shouldRestore) this.scheduleShowFallback(ghostId, slot);
  }

  private invalidateSlot(ghostId: string, slot: WindowSlot, reason: string): void {
    if (slot.win.isDestroyed()) return;
    const reopen = slot.pendingShow || slot.visible;
    const attempts = slot.automaticRecoveryAttempts;
    this.deps.log.warn('ghost overlay cached window invalidated', { ghostId, reason, reopen });
    this.disposeSlot(ghostId, slot);
    if (!reopen || this.disposed || this.deps.isQuitting()) return;
    if (attempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      this.deps.log.error('ghost overlay automatic recovery exhausted', { ghostId, reason });
      return;
    }
    // 重建并重新 show:恢复额度在 presentationReady 时进入稳定窗口后重置。
    void this.ensureSlot(ghostId).then((replacement) => {
      if (!replacement) return;
      replacement.automaticRecoveryAttempts = attempts + 1;
      replacement.pendingShow = true;
      this.scheduleShowFallback(ghostId, replacement);
      this.broadcast();
    });
  }

  // ── 销毁 ────────────────────────────────────────────────────────────

  /** 销毁一个「已创建但尚未挂载」的窗口并清理其 registry 绑定。 */
  private disposeAbandonedWindow(win: BrowserWindow): void {
    let webContentsId: number | null = null;
    try {
      webContentsId = win.webContents.id;
    } catch {
      // webContents 已不可访问,无可清理。
    }
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // already gone
    }
    if (webContentsId !== null) clearGhostOverlayWebContents(webContentsId);
  }

  private disposeSlot(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    this.slots.delete(ghostId);
    slot.destroyingWindow = true;
    clearGhostOverlayWebContents(slot.webContentsId);
    try {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    } catch {
      // already gone
    }
  }

  /** 主窗口销毁/owner 切换时回收所有隐藏窗口;controller 仍可继续预热。 */
  destroyAllWindows(): void {
    this.generation += 1;
    this.pendingCreates.clear();
    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      this.clearTimeouts(slot);
      slot.destroyingWindow = true;
      clearGhostOverlayWebContents(slot.webContentsId);
      try {
        if (!slot.win.isDestroyed()) slot.win.destroy();
      } catch {
        // already gone
      }
    }
  }

  private clearTimeouts(slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    if (slot.recoveryStabilityTimeout) {
      clearTimeout(slot.recoveryStabilityTimeout);
      slot.recoveryStabilityTimeout = null;
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  private entryState(slot: WindowSlot): GhostOverlayWindowEntryState {
    return {
      mounted: !slot.win.isDestroyed(),
      visible: slot.visible && !slot.win.isDestroyed(),
      interactive: slot.interactive,
    };
  }

  private broadcast(): void {
    this.deps.broadcastState(this.getState());
  }
}

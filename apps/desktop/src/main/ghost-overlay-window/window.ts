/**
 * createGhostOverlayWindow —— 桌面浮窗(ghost overlay window)的 BrowserWindow 工厂。
 *
 * 蓝本是 session-drag-preview.ts 的透明置顶窗口,加上 ghost-panel-window 的
 * 按 ghostId 多实例与显式全量安全字段:
 *  - 形态参数为 2026-10-15 spike 实机验证过的冻结值(透明、无边框、不可交互
 *    拖拽、默认穿透、floating 置顶);
 *  - 尺寸缺省 GHOST_OVERLAY_DEFAULT_SIZE(128),边界 32–512 已由 Task 2 校验,
 *    工厂直接用 decl 的显式值或默认值;
 *  - webPreferences 按 electron-security-and-process-boundaries §3 逐项写明,
 *    不吃默认值;partition 用 owner-scoped ghost 分区(与 electronSandboxAdapter
 *    的 cindy-ghost:// 协议 handler 同一 session);
 *  - 承载路线首选直载 cindy-ghost://<ghostId>/<decl.html>,加载前先
 *    ensureProtocolRegistered(依赖注入,bootstrap 接线属 Task 7)。
 */

import { BrowserWindow, app } from 'electron';

import {
  GHOST_SCHEME,
  GHOST_OVERLAY_DEFAULT_SIZE,
  type GhostOverlayDecl,
} from '../../shared/ghost.js';
import type { Logger } from '../logger.js';
import { getActiveAppSession } from '../appSessionState.js';
import { ownerScopedGhostPartition } from '../cindy-brain/ghostWebviewPartition.js';
import { markGhostOverlayWebContentsId } from './registry.js';

export interface GhostOverlayWindowDeps {
  /** 确保该意识 owner 分区上的 cindy-ghost:// 协议 handler 就位(幂等)。 */
  ensureProtocolRegistered: (ghostId: string) => Promise<void>;
  log: Logger;
}

/**
 * 创建一段意识的桌面浮窗。
 *
 * @returns 已加载 overlay 入口的 BrowserWindow(display 时机由 controller 控制)。
 */
export async function createGhostOverlayWindow(
  ghostId: string,
  decl: GhostOverlayDecl,
  deps: GhostOverlayWindowDeps,
): Promise<BrowserWindow> {
  const { ensureProtocolRegistered, log } = deps;
  const width = decl.width ?? GHOST_OVERLAY_DEFAULT_SIZE;
  const height = decl.height ?? GHOST_OVERLAY_DEFAULT_SIZE;

  // 浮窗与 cindy-ghost:// 协议 handler 必须落在同一 owner-scoped session。
  const owner = getActiveAppSession();
  const partition = ownerScopedGhostPartition(ghostId, owner);
  if (!partition) {
    throw new Error('ghost overlay requires an active data owner');
  }

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: {
      partition,
      // 安全规则 §3 全量显式项(新建窗口不吃默认值,逐项写明):
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // packaged 版关掉浮窗 devTools;dev 保留便于排查示例意识。
      devTools: !app.isPackaged,
    },
  });

  // 默认穿透:鼠标事件透传到浮窗下层,窗口自身不抢焦点。
  win.setIgnoreMouseEvents(true, { forward: true });
  // floating 层 + relativeLevel 1,保持置顶但低于系统级覆盖物。
  win.setAlwaysOnTop(true, 'floating', 1);

  // ── 守卫(设计 §4.7)────────────────────────────────────────────────
  // 浮窗零弹窗:一律 deny,不转外链(与 secondary-windows 的 shell.openExternal 不同)。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 导航限定在自己的 cindy-ghost://<ghostId>/ 内,越界一律掐断。
  const allowedPrefix = `${GHOST_SCHEME}://${ghostId}/`;
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
    }
  });
  // 权限请求全拒:浮窗是意识自绘页,不给通知 / 摄像头 / 定位等任何宿主权限。
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  markGhostOverlayWebContentsId(win.webContents.id, ghostId);

  // 协议 handler 必须先于 loadURL 挂好,否则直载会 404 / 空响应。
  await ensureProtocolRegistered(ghostId);
  await win.loadURL(`${GHOST_SCHEME}://${ghostId}/${decl.html}`);

  log.info('ghost overlay window created', { ghostId });
  return win;
}

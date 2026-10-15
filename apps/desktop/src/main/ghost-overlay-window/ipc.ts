/**
 * registerGhostOverlayWindowIpc —— 桌面浮窗(ghost overlay window)的 IPC 注册。
 *
 * 沿用 ghost-panel-window/ipc.ts 模式:
 *  - GET_STATE / SET_USER_ENABLED:invoke,断言 Cindy 自有顶层 renderer
 *    (assertTrustedAppRendererEvent)。浮窗自身不是 app content 窗口,不在该
 *    信任集内;
 *  - 就绪握手(RENDERER_READY / PRESENTATION_READY):invoke,但 sender 必须是
 *    Task 3 registry 里已登记的浮窗 webContents——用 webContents.id 反查
 *    ghostId 验身,再交给 controller.mark*Ready(sender)(controller 内部再按
 *    slotForSender 把 sender 映射到具体 ghostId);
 *  - VISIBILITY_CHANGED 推送由 controller 直接发浮窗 webContents(见
 *    controller.sendVisibility),这里不另注册。
 *
 * 用户开关的持久化归 Task 8;本任务只做通道与校验,写入经注入的
 * setUserEnabled(ghostId, enabled) 转交(运行期占位)。
 */

import { ipcMain } from 'electron';

import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isValidPluginStoragePart } from '../../shared/pluginIdentity.js';
import {
  GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL,
  GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL,
} from '../../shared/ghostOverlayWindow.js';
import type { GhostOverlayWindowsController } from './controller.js';
import { ghostIdForOverlayWebContents } from './registry.js';

export interface GhostOverlayWindowIpcDeps {
  controller: GhostOverlayWindowsController;
  /** Task 8 持久化前的运行期写入点;本任务只负责通道与载荷校验。 */
  setUserEnabled: (ghostId: string, enabled: boolean) => void;
}

export function registerGhostOverlayWindowIpc(deps: GhostOverlayWindowIpcDeps): void {
  const { controller, setUserEnabled } = deps;

  ipcMain.handle(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_GET_STATE, (event) => {
    assertTrustedAppRendererEvent(event);
    return controller.getState();
  });

  ipcMain.handle(
    MAKER_INVOKE.GHOST_OVERLAY_WINDOW_SET_USER_ENABLED,
    (event, ghostId: unknown, enabled: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (!isValidPluginStoragePart(ghostId)) {
        throwIpcError('INVALID_PARAMS', 'ghostId must be a valid ghost id');
      }
      if (typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
      }
      setUserEnabled(ghostId, enabled);
    },
  );

  // ── 双阶段就绪握手 ────────────────────────────────────────────────
  // 浮窗页零桥、不在信任 app renderer 集合内;身份只能靠 Task 3 registry 反查,
  // 未登记的 webContents 一律拒绝(fail closed),不接受 renderer 自报 ghostId。

  ipcMain.handle(GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL, (event) => {
    const ghostId = ghostIdForOverlayWebContents(event.sender.id);
    if (!ghostId) {
      throwIpcError('PERMISSION_DENIED', 'overlay ready channel 只能由已登记的浮窗页面发起');
    }
    controller.markRendererReady(event.sender);
  });

  ipcMain.handle(GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL, (event) => {
    const ghostId = ghostIdForOverlayWebContents(event.sender.id);
    if (!ghostId) {
      throwIpcError('PERMISSION_DENIED', 'overlay ready channel 只能由已登记的浮窗页面发起');
    }
    controller.markPresentationReady(event.sender);
  });
}

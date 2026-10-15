/**
 * registerGhostOverlayWindowIpc 单测(DI only,不依赖真 electron)。
 * 覆盖:sender 校验(GET_STATE 未信任 sender 被拒)、ready 通道对非登记
 * webContents 被拒、ready 通道经 registry 映射到正确 ghostId、以及
 * SET_USER_ENABLED 的 ghostId / boolean 载荷校验。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 信任断言 mock:默认放行,单个用例按需改成 throw 以模拟未信任 sender。
const trustedMocks = vi.hoisted(() => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('electron', () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      __handlers: handlers,
    },
  };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: trustedMocks.assertTrustedAppRendererEvent,
}));

import { ipcMain } from 'electron';

import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import {
  GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL,
  GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL,
} from '../../../shared/ghostOverlayWindow.js';
import {
  clearGhostOverlayWebContents,
  ghostIdForOverlayWebContents,
  markGhostOverlayWebContentsId,
} from '../registry.js';
import { registerGhostOverlayWindowIpc } from '../ipc.js';
import type { GhostOverlayWindowsController } from '../controller.js';

type OverlayControllerMock = GhostOverlayWindowsController & {
  getState: ReturnType<typeof vi.fn>;
  markRendererReady: ReturnType<typeof vi.fn>;
  markPresentationReady: ReturnType<typeof vi.fn>;
  rendererReadyGhostIds: string[];
  presentationReadyGhostIds: string[];
};

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function makeController(): OverlayControllerMock {
  const rendererReadyGhostIds: string[] = [];
  const presentationReadyGhostIds: string[] = [];
  return {
    getState: vi.fn(() => ({
      'ghost-a': { mounted: true, visible: false, interactive: false },
    })),
    // 模拟真实 controller 的 slotForSender:按 registry 把 sender 映射回 ghostId,
    // 让 ready 通道的“映射到正确 ghostId”可观察(而不只是布尔闸通过)。
    markRendererReady: vi.fn((sender: { id: number }) => {
      const ghostId = ghostIdForOverlayWebContents(sender.id);
      if (ghostId) rendererReadyGhostIds.push(ghostId);
    }),
    markPresentationReady: vi.fn((sender: { id: number }) => {
      const ghostId = ghostIdForOverlayWebContents(sender.id);
      if (ghostId) presentationReadyGhostIds.push(ghostId);
    }),
    rendererReadyGhostIds,
    presentationReadyGhostIds,
  } as unknown as OverlayControllerMock;
}

function handlerFor(channel: string): Handler {
  const handlers = (
    ipcMain as unknown as {
      __handlers: Map<string, Handler>;
    }
  ).__handlers;
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler;
}

/**
 * 模拟 Electron ipcMain.handle 的语义:handler 同步 throw 也会折叠成 rejected
 * promise,而不是把异常抛进测试体。
 */
async function invoke(handler: Handler, event: unknown, ...args: unknown[]): Promise<unknown> {
  return handler(event, ...args);
}

beforeEach(() => {
  (
    ipcMain as unknown as {
      __handlers: Map<string, unknown>;
    }
  ).__handlers.clear();
  (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear();
  trustedMocks.assertTrustedAppRendererEvent.mockReset();
  trustedMocks.assertTrustedAppRendererEvent.mockImplementation(() => {});
  clearGhostOverlayWebContents(42);
  clearGhostOverlayWebContents(43);
});

describe('ghost overlay window IPC', () => {
  it('rejects GET_STATE from an untrusted sender', async () => {
    const controller = makeController();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled: vi.fn() });

    trustedMocks.assertTrustedAppRendererEvent.mockImplementation(() => {
      throw new Error('PERMISSION_DENIED: 只能从 Cindy 主页面发起');
    });

    const handler = handlerFor(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_GET_STATE);
    await expect(invoke(handler, { sender: { id: 1 } })).rejects.toThrow(/PERMISSION_DENIED/);
    expect(controller.getState).not.toHaveBeenCalled();
  });

  it('returns controller state for a trusted GET_STATE sender', async () => {
    const controller = makeController();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled: vi.fn() });

    const handler = handlerFor(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_GET_STATE);
    await expect(invoke(handler, { sender: { id: 1 } })).resolves.toEqual({
      'ghost-a': { mounted: true, visible: false, interactive: false },
    });
    expect(controller.getState).toHaveBeenCalledTimes(1);
  });

  it('rejects ready channels from webContents that are not a registered overlay', async () => {
    const controller = makeController();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled: vi.fn() });

    const rendererReady = handlerFor(GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL);
    const presentationReady = handlerFor(GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL);

    await expect(invoke(rendererReady, { sender: { id: 99 } })).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(invoke(presentationReady, { sender: { id: 99 } })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(controller.markRendererReady).not.toHaveBeenCalled();
    expect(controller.markPresentationReady).not.toHaveBeenCalled();
  });

  it('maps renderer-ready/presentation-ready to the right ghostId via registry', async () => {
    markGhostOverlayWebContentsId(42, 'ghost-a');
    markGhostOverlayWebContentsId(43, 'ghost-b');
    const controller = makeController();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled: vi.fn() });

    const rendererReady = handlerFor(GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL);
    const presentationReady = handlerFor(GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL);

    await invoke(rendererReady, { sender: { id: 42 } });
    await invoke(presentationReady, { sender: { id: 43 } });

    expect(controller.markRendererReady).toHaveBeenCalledWith({ id: 42 });
    expect(controller.markPresentationReady).toHaveBeenCalledWith({ id: 43 });
    // 加严:ready 通道经 registry 映射到**正确的 ghostId**(而非只过布尔闸)。
    expect(controller.rendererReadyGhostIds).toEqual(['ghost-a']);
    expect(controller.presentationReadyGhostIds).toEqual(['ghost-b']);
  });

  it('SET_USER_ENABLED validates ghostId and boolean payload', async () => {
    const controller = makeController();
    const setUserEnabled = vi.fn();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled });

    const handler = handlerFor(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_SET_USER_ENABLED);

    await expect(invoke(handler, { sender: { id: 1 } }, 'not a valid id', true)).rejects.toThrow(
      /ghostId/,
    );
    await expect(invoke(handler, { sender: { id: 1 } }, 'ghost-a', 'yes')).rejects.toThrow(
      /enabled/,
    );
    await expect(invoke(handler, { sender: { id: 1 } }, 'ghost-a', 1)).rejects.toThrow(/enabled/);

    await invoke(handler, { sender: { id: 1 } }, 'ghost-a', false);
    expect(setUserEnabled).toHaveBeenCalledTimes(1);
    expect(setUserEnabled).toHaveBeenCalledWith('ghost-a', false);
  });

  it('SET_USER_ENABLED rejects an untrusted sender', async () => {
    const controller = makeController();
    const setUserEnabled = vi.fn();
    registerGhostOverlayWindowIpc({ controller, setUserEnabled });

    trustedMocks.assertTrustedAppRendererEvent.mockImplementation(() => {
      throw new Error('PERMISSION_DENIED: 只能从 Cindy 主页面发起');
    });

    const handler = handlerFor(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_SET_USER_ENABLED);
    await expect(invoke(handler, { sender: { id: 1 } }, 'ghost-a', true)).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(setUserEnabled).not.toHaveBeenCalled();
  });
});

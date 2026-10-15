import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * createGhostOverlayWindow 的窗口参数 / 守卫单测。
 *
 * electron 走 vi.mock 的 FakeWindow（参照 computer-permission-guide 的
 * electron-window.test.ts）；appSessionState 仅 mock 出当前 owner 与
 * dataOwnerStorageKey，让真实 ownerScopedGhostPartition 的命名逻辑原样参与
 * 断言（分区命名本身已在 ghostWebviewPartition.test.ts 单独钉住）。
 */

const harness = vi.hoisted(() => {
  const app = { isPackaged: false };
  let nextWebContentsId = 1;
  const windows: FakeWindow[] = [];
  const ensureProtocolRegistered = vi.fn(async () => undefined);

  class FakeWindow {
    readonly loadURL = vi.fn(async () => undefined);
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly webContents: {
      id: number;
      on: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      session: { setPermissionRequestHandler: ReturnType<typeof vi.fn> };
    };

    constructor(readonly options: BrowserWindowConstructorOptions) {
      this.webContents = {
        id: nextWebContentsId++,
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn() },
      };
      windows.push(this);
    }
  }

  return {
    app,
    windows,
    ensureProtocolRegistered,
    FakeWindow,
    reset: () => {
      app.isPackaged = false;
      nextWebContentsId = 1;
      windows.length = 0;
      ensureProtocolRegistered.mockReset();
      ensureProtocolRegistered.mockResolvedValue(undefined);
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.FakeWindow,
  app: harness.app,
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: 'local' as const,
    dataOwnerId: 'local-owner',
    generation: 1,
  }),
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
}));

import { createGhostOverlayWindow } from '../window.js';

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

function deps() {
  return { ensureProtocolRegistered: harness.ensureProtocolRegistered, log };
}

function webPreferences(win: (typeof harness.windows)[number]): Record<string, unknown> {
  return win.options.webPreferences as Record<string, unknown>;
}

describe('createGhostOverlayWindow', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.reset();
    log.info.mockReset();
  });

  it('creates the overlay window with the frozen avatar and default size', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(harness.windows).toHaveLength(1);
    expect(harness.windows[0].options).toMatchObject({
      width: 128,
      height: 128,
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
    });

    // decl 给 64 时使用显式尺寸。
    harness.reset();
    await createGhostOverlayWindow(
      'acme-overlay',
      { html: 'overlay.html', width: 64, height: 64 },
      deps(),
    );
    expect(harness.windows[0].options).toMatchObject({ width: 64, height: 64 });
  });

  it('applies full security fields explicitly', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(webPreferences(harness.windows[0])).toMatchObject({
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
    });
  });

  it('enables click-through by default and floating top level', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(harness.windows[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true, {
      forward: true,
    });
    expect(harness.windows[0].setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating', 1);
  });

  it('loads the plugin overlay page from its owner-scoped partition', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    expect(webPreferences(win).partition).toBe(
      'cindy-ghost-owner:local:opaque-local-owner:acme-overlay',
    );
    expect(harness.ensureProtocolRegistered).toHaveBeenCalledWith('acme-overlay');
    expect(win.loadURL).toHaveBeenCalledWith('cindy-ghost://acme-overlay/overlay.html');

    // ensureProtocolRegistered 必须先于 loadURL（否则直载会落在未挂协议的 session）。
    const registerOrder = harness.ensureProtocolRegistered.mock.invocationCallOrder[0];
    const loadOrder = win.loadURL.mock.invocationCallOrder[0];
    expect(registerOrder).toBeDefined();
    expect(loadOrder).toBeDefined();
    expect(registerOrder!).toBeLessThan(loadOrder!);
  });

  it('denies window.open and blocks out-of-plugin navigation', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    const openHandler = win.webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: {
      url: string;
    }) => { action: string };
    expect(openHandler({ url: 'https://x' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'cindy-ghost://acme-overlay/other.html' })).toEqual({
      action: 'deny',
    });

    const navCall = win.webContents.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    );
    expect(navCall).toBeDefined();
    const navHandler = navCall![1] as (
      event: { preventDefault(): void },
      url: string,
    ) => void;

    const preventDefault = vi.fn();
    navHandler({ preventDefault }, 'cindy-ghost://other/x');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    preventDefault.mockClear();
    navHandler({ preventDefault }, 'https://x');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // 自己 ghost 内的导航放行。
    preventDefault.mockClear();
    navHandler({ preventDefault }, 'cindy-ghost://acme-overlay/other.html');
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('rejects all permission requests', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    const handler = win.webContents.session.setPermissionRequestHandler.mock
      .calls[0]![0] as (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const callback = vi.fn();
    handler(win.webContents, 'notifications', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('disables devTools in packaged builds only', async () => {
    harness.app.isPackaged = true;
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());
    expect(webPreferences(harness.windows[0]).devTools).toBe(false);

    harness.reset();
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());
    expect(webPreferences(harness.windows[0]).devTools).toBe(true);
  });
});

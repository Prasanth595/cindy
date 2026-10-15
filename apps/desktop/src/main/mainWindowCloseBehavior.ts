import type { LinuxCloseBehavior } from '../shared/windowBehavior.js';

/** BrowserWindow surface needed for Linux's keep-running close action. */
export interface LinuxCloseBehaviorWindow {
  hide(): void;
  minimize(): void;
}

/**
 * How the "keep running" close choice keeps the app alive. On Linux Wayland most
 * compositors (e.g. Hyprland) never act on toplevel minimize requests, so the
 * window must hide to tray instead; X11 keeps the classic minimize.
 */
export interface LinuxCloseBehaviorActions {
  quit(): void;
  keepRunning(window: LinuxCloseBehaviorWindow): void;
}

/**
 * True when running under a Wayland session. `XDG_SESSION_TYPE` is the primary
 * signal; a set `WAYLAND_DISPLAY` covers display managers that leave it unset.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.XDG_SESSION_TYPE) return env.XDG_SESSION_TYPE === 'wayland';
  return Boolean(env.WAYLAND_DISPLAY);
}

/** Apply the persisted Linux choice without coupling the policy to Electron globals. */
export function applyLinuxMainWindowCloseBehavior(
  window: LinuxCloseBehaviorWindow,
  behavior: LinuxCloseBehavior,
  actions: LinuxCloseBehaviorActions,
): void {
  if (behavior === 'minimize') {
    actions.keepRunning(window);
  } else {
    actions.quit();
  }
}

/** BrowserWindow surface needed to reveal the renderer-owned close behavior dialog. */
export interface MainWindowClosePromptWindow {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** Keep the main window visible and ask its renderer to show the platform chooser. */
export function requestMainWindowCloseBehavior(
  window: MainWindowClosePromptWindow,
  channel: string,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.send(channel);
}

/** Injectable side effects for the renderer-first close behavior prompt flow. */
export interface CloseBehaviorPromptFallbackDependencies<TBehavior> {
  readBehavior(): TBehavior | null;
  showRendererPrompt(): void;
  showNativePrompt(): TBehavior;
  persistBehavior(behavior: TBehavior): void;
  applyBehavior(behavior: TBehavior): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Lifecycle exposed to the Electron adapter for requests, renderer ACKs, and shutdown. */
export interface CloseBehaviorPromptFallbackController {
  request(): void;
  acknowledge(): void;
  dispose(): void;
}

/**
 * Prefer the Cindy renderer dialog, but fall back to a native prompt if the renderer never
 * confirms that the dialog mounted. This keeps first-close reliable during startup or crashes.
 */
export function createCloseBehaviorPromptFallbackController<TBehavior>(
  deps: CloseBehaviorPromptFallbackDependencies<TBehavior>,
  fallbackDelayMs: number,
): CloseBehaviorPromptFallbackController {
  let fallbackHandle: unknown;

  const cancelFallback = (): void => {
    if (fallbackHandle === undefined) return;
    deps.cancel(fallbackHandle);
    fallbackHandle = undefined;
  };

  const runFallback = (): void => {
    fallbackHandle = undefined;
    if (deps.readBehavior()) return;

    const behavior = deps.showNativePrompt();
    // The renderer can persist a choice while the native dialog is open; keep the first choice.
    if (deps.readBehavior()) return;
    deps.persistBehavior(behavior);
    deps.applyBehavior(behavior);
  };

  return {
    request() {
      if (deps.readBehavior()) return;
      deps.showRendererPrompt();
      if (fallbackHandle !== undefined) return;
      fallbackHandle = deps.schedule(runFallback, fallbackDelayMs);
    },
    acknowledge() {
      cancelFallback();
    },
    dispose() {
      cancelFallback();
    },
  };
}

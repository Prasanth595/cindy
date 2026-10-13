import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readDesktopInputPermission,
  resolveDesktopInputBinary,
} from '../remote-desktop/inputHost.js';
import type {
  NativeActRequest,
  NativeActResult,
  NativeAxSnapshot,
  NativeWindowList,
  NativeWindowRef,
  PointerRequest,
  WindowCapture,
  WindowCaptureError,
} from './types.js';
import { captureWindowArea } from './windowCapture.js';

const exec = promisify(execFile);

/** Operating-system surface used by a handoff session; faked in tests. */
export interface HandoffDriver {
  permission(): Promise<'granted' | 'missing' | 'unknown'>;
  requestPermission(): Promise<void>;
  windows(): Promise<NativeWindowList>;
  snapshot(pid: number, window?: NativeWindowRef): Promise<NativeAxSnapshot | { error: string }>;
  act(request: NativeActRequest): Promise<NativeActResult>;
  /** Command line of a process, for agent-controlled target detection only. */
  commandLine(pid: number): Promise<string>;
  /** Screenshot steps. Absent where the platform cannot photograph a single window. */
  capture?(target: { pid: number; window: NativeWindowRef }): Promise<WindowCapture | { error: WindowCaptureError }>;
  focusedField?(pid: number): Promise<{ editable: boolean; secure: boolean }>;
  pointer?(request: PointerRequest): Promise<NativeActResult>;
  /** Bring the window to the front; its frame and window-server id, for a live view of just that window. */
  raise?(target: { pid: number; window: NativeWindowRef }): Promise<{ frame: number[]; windowId: number } | { error: WindowCaptureError }>;
}

/**
 * Runs the authenticated native helper once per request. Requests travel on
 * stdin so owner values never appear in argv, environment or logs; replies
 * never contain them.
 */
async function runHelper(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const binary = await resolveDesktopInputBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--handoff'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error('INPUT_HANDOFF_HELPER_TIMEOUT'));
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8_000_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const line = output.trim();
      if (line === 'permission') return resolve({ error: 'permission' });
      if (code === 77) return resolve({ error: 'unavailable' });
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: code === 0 ? 'invalid' : 'unavailable' });
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

/**
 * Whether typing into this app would land in a password field: the element at
 * a screen point, or the focused element. Used to point the agent at 代输入
 * instead of typing a secret. Unknown (no permission, helper failure) is false.
 */
export async function isSecureInputTarget(target: { pid: number; point?: { x: number; y: number } }): Promise<boolean> {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(target.pid) || target.pid <= 0) return false;
  const point = target.point && Number.isFinite(target.point.x) && Number.isFinite(target.point.y)
    ? [target.point.x, target.point.y] : undefined;
  try {
    const result = (await runHelper({ op: 'secure', pid: target.pid, ...(point ? { point } : {}) }, 3000)) as { secure?: unknown };
    return result?.secure === true;
  } catch {
    return false;
  }
}

async function raiseWindow(target: { pid: number; window: NativeWindowRef }): Promise<
  { frame: number[]; windowId?: number } | { error: WindowCaptureError }
> {
  const raised = (await runHelper({ op: 'raise', pid: target.pid, window: target.window }, 6000)) as {
    frame?: unknown;
    windowId?: unknown;
    error?: string;
  };
  const frame = raised.frame;
  if (!Array.isArray(frame) || frame.length !== 4 || !frame.every((n) => typeof n === 'number' && Number.isFinite(n)))
    return { error: raised.error === 'target_gone' ? 'target_gone' : raised.error === 'permission' ? 'permission' : 'unavailable' };
  const windowId = raised.windowId;
  return {
    frame: frame as number[],
    ...(typeof windowId === 'number' && Number.isSafeInteger(windowId) && windowId > 0 && windowId <= 0xffff_ffff ? { windowId } : {}),
  };
}

export function createMacHandoffDriver(): HandoffDriver {
  return {
    async permission() {
      const status = await readDesktopInputPermission();
      return status === 'granted' ? 'granted' : status === 'missing' ? 'missing' : 'unknown';
    },
    async requestPermission() {
      const binary = await resolveDesktopInputBinary();
      await exec(binary, ['--request-permission'], { timeout: 5000, maxBuffer: 1024 }).catch(() => undefined);
    },
    async windows() {
      const result = (await runHelper({ op: 'windows' }, 8000)) as NativeWindowList & { error?: string };
      if (result.error || !Array.isArray(result.apps)) throw new Error(result.error ?? 'unavailable');
      return result;
    },
    async snapshot(pid, window) {
      const result = (await runHelper({ op: 'snapshot', pid, ...(window ? { window } : {}) }, 10_000)) as
        | NativeAxSnapshot
        | { error: string };
      return result;
    },
    async act(request) {
      return (await runHelper({ op: 'act', ...request }, 15_000)) as NativeActResult;
    },
    async capture(target) {
      const raised = await raiseWindow(target);
      return 'error' in raised ? raised : captureWindowArea(raised.frame);
    },
    async raise(target) {
      const raised = await raiseWindow(target);
      if ('error' in raised) return raised;
      return raised.windowId ? { frame: raised.frame, windowId: raised.windowId } : { error: 'unavailable' };
    },
    async focusedField(pid) {
      const result = (await runHelper({ op: 'focused', pid }, 3000)) as { editable?: unknown; secure?: unknown };
      return { editable: result.editable === true, secure: result.secure === true };
    },
    async pointer(request) {
      return (await runHelper({ op: 'pointer', ...request }, 10_000)) as NativeActResult;
    },
    async commandLine(pid) {
      try {
        const { stdout } = await exec('/bin/ps', ['-o', 'args=', '-p', String(pid)], {
          timeout: 3000,
          maxBuffer: 64 * 1024,
        });
        return stdout.trim();
      } catch {
        return '';
      }
    },
  };
}

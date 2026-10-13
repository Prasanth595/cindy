import type { HandoffDriver } from '../macDriver.js';
import type { NativeActRequest, NativeAxNode, NativeAxSnapshot, NativeWindowList, PointerRequest } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? ''}`, enabled: true, frame: [10, 10, 100, 20], ...extra,
});

type Stage = 'choose' | 'org' | 'browser' | 'done';

/** A generic multi-step flow: choose → type → browser consent → back in the app. */
export function fakeDesktop(options: { pictures?: boolean; live?: boolean } = {}) {
  let stage: Stage = 'choose';
  const acts: NativeActRequest[] = [];
  const pointers: PointerRequest[] = [];
  const raised: number[] = [];
  const app = { pid: 10, app: 'Example', bundleId: 'com.example.app' };
  const browser = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
  const windows = (): NativeWindowList => ({
    frontmost: stage === 'browser' ? 20 : 10,
    apps: [
      { ...app, windows: [{ index: 0, title: stage === 'done' ? 'Example' : 'Sign in', frame: [0, 0, 800, 600], focused: true, minimized: false }] },
      { ...browser, windows: [{ index: 0, title: 'Authorize', frame: [0, 0, 800, 600], focused: true, minimized: false }] },
      { pid: 1, app: 'Cindy', bundleId: 'host', windows: [{ index: 0, title: 'Cindy', frame: [0, 0, 1, 1], focused: true, minimized: false }] },
    ],
  });
  const snapshot = (pid: number): NativeAxSnapshot => {
    const base = { pid, frontmost: true, window: { index: 0, title: '', frame: [0, 0, 800, 600] } };
    if (pid === 20) {
      return { ...base, ...browser, window: { ...base.window, title: 'Authorize' }, nodes: stage === 'browser' ? [
        node('0', 'AXWebArea', { url: 'https://auth.example.com/consent', frame: [0, 0, 800, 600] }),
        node('0.0', 'AXHeading', { title: 'Allow Example to access your account?' }),
        node('0.1', 'AXButton', { title: 'Authorize' }),
        node('0.2', 'AXButton', { title: 'Cancel' }),
      ] : [node('0', 'AXWebArea', { url: 'https://auth.example.com/ok', frame: [0, 0, 800, 600] }), node('0.0', 'AXStaticText', { value: 'You can close this tab' })] };
    }
    if (stage === 'choose') return { ...base, ...app, window: { ...base.window, title: 'Sign in' }, nodes: [
      node('0', 'AXRadioGroup', { desc: 'Sign-in method' }),
      node('0.0', 'AXRadioButton', { title: 'Personal', checked: true }),
      node('0.1', 'AXRadioButton', { title: 'Enterprise', checked: false }),
      node('1', 'AXButton', { title: 'Continue' }),
    ] };
    if (stage === 'org') return { ...base, ...app, window: { ...base.window, title: 'Sign in' }, nodes: [
      node('0', 'AXTextField', { title: 'Organization code' }),
      node('1', 'AXButton', { title: 'Next' }),
    ] };
    return { ...base, ...app, window: { ...base.window, title: 'Example' }, nodes: [
      node('0', 'AXButton', { title: 'New task' }),
      node('1', 'AXButton', { title: 'Settings' }),
    ] };
  };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => windows(),
    snapshot: async (pid) => snapshot(pid),
    commandLine: async () => '',
    act: async (request) => {
      acts.push(request);
      if (stage === 'choose' && request.kind === 'press' && request.ref === '1') stage = 'org';
      else if (stage === 'org' && request.kind === 'press' && request.ref === '1') stage = 'browser';
      else if (stage === 'browser' && request.kind === 'press' && request.ref === '0.1') stage = 'done';
      return { ok: true };
    },
    ...(options.pictures
      ? {
          capture: async () => {
            const frame = [0, 0, 800, 600];
            return { jpeg: Buffer.from(`picture-of-${stage}`), width: 800, height: 600, area: frame, windowFrame: frame };
          },
          focusedField: async () => ({ editable: false, secure: false }),
          // A tap on "Continue" (bottom right of the picture) moves on like pressing it.
          pointer: async (request: PointerRequest) => {
            pointers.push(request);
            if (stage === 'choose' && request.kind === 'tap' && request.point[0] > 400) stage = 'org';
            return { ok: true as const };
          },
        }
      : {}),
    ...(options.live
      ? {
          raise: async (target: { pid: number }) => {
            raised.push(target.pid);
            return { frame: [0, 0, 800, 600], windowId: 900 + target.pid };
          },
        }
      : {}),
  };
  return {
    driver,
    acts,
    pointers,
    raised,
    stage: () => stage,
    /** The owner finished the step in the live view, outside the card. */
    advanceOutside: (next: Stage) => {
      stage = next;
    },
  };
}

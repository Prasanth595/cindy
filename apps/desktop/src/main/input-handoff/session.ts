import {
  INPUT_HANDOFF_PICTURE_TEXT_ID,
  validateInputHandoffSubmissionForStep,
  type InputHandoffControl,
  type InputHandoffDecision,
  type InputHandoffFailure,
  type InputHandoffHolder,
  type InputHandoffPhase,
  type InputHandoffPicture,
  type InputHandoffSnapshot,
  type InputHandoffSource,
  type InputHandoffSubmission,
} from '@cindy/device-link';
import { HumanDesktopInput } from '../remote-desktop/inputOwnership.js';
import type { HandoffDriver } from './macDriver.js';
import { extractStep, type ExtractedStep } from './stepExtractor.js';
import type {
  ControlBinding,
  HandoffTarget,
  NativeActResult,
  NativeAxSnapshot,
  NativeWindowList,
  WindowCapture,
} from './types.js';

/** The current screenshot step; the JPEG is wiped as soon as the step is left. */
interface PictureStep extends WindowCapture {
  /** A text field had focus when photographed; the card shows one box for it. */
  field?: 'text' | 'password';
}

/**
 * Something on the step the owner can act on, beyond headings and messages.
 * A sign-in code to copy counts too: the owner acts on it on their own device.
 */
const actionable = (step: ExtractedStep) =>
  !!step.deviceCode || step.controls.some((control) => control.kind !== 'note');

export interface HandoffTargetSpec {
  app?: string;
  pid?: number;
  windowTitle?: string;
}

export interface HandoffCompletionHints {
  windowClosed?: boolean;
  textAppears?: string;
  urlContains?: string;
}

export type HandoffEndReason = 'owner' | 'detected' | 'cancelled' | 'declined' | 'timeout' | 'failure' | 'session_closed';

export interface HandoffResult {
  status: 'succeeded' | 'cancelled' | 'failed' | 'expired';
  reason: HandoffEndReason;
  steps: number;
  failure?: InputHandoffFailure;
  finalApp?: string;
  finalWindow?: string;
  finalOrigin?: string;
  /** Device that answered the last applied step; absent when no values were applied. */
  answeredOn?: InputHandoffHolder;
}

/** The window a live view shows, located by the host when the owner opens it. */
export interface LiveHandoffWindow {
  pid: number;
  app: string;
  title?: string;
  windowId: number;
  /** Screen frame in points: x, y, width, height. */
  frame: number[];
}

export interface HandoffSessionOptions {
  requestId: string;
  purpose: string;
  note?: string;
  requester?: string;
  target: HandoffTargetSpec;
  completeWhen?: HandoffCompletionHints;
  timeoutMs: number;
  /** Cindy itself; never a handoff target and never followed into. */
  hostPid: number;
  remoteInput: boolean;
  /** Whether another device may open a live view of the window right now (remote desktop allowed). */
  liveView?: () => boolean;
  driver: HandoffDriver;
  publish(snapshot: InputHandoffSnapshot): void;
  finish(result: HandoffResult): void;
  /** A secret was typed into a page the agent controls (automation browser); restrict its page reads. */
  onSecretEntered?(target: { pid: number; url?: string }): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  finishingDelayMs?: number;
  settleTimeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Handoffs move keyboard focus; only one may act on the desktop at a time.
 * While Cindy types for the owner it holds the same lease as remote-desktop
 * input, so the agent's own Computer Use waits and must observe again after.
 */
let desktopTurn: Promise<unknown> = Promise.resolve();
function withDesktopTurn<T>(work: () => Promise<T>): Promise<T> {
  const owned = async () => {
    const lease = new HumanDesktopInput();
    const turn = lease.begin([]);
    try {
      await turn.ready;
      return await work();
    } finally {
      turn.complete();
      lease.release();
    }
  };
  const run = desktopTurn.then(owned, owned);
  desktopTurn = run.catch(() => undefined);
  return run;
}

function sameHolder(a: InputHandoffHolder, b: InputHandoffHolder): boolean {
  return a.local === true ? b.local === true : b.local !== true && a.deviceId === b.deviceId;
}

const AUTOMATION_FLAGS = /--(remote-debugging-(port|pipe)|enable-automation|headless)\b/;

/**
 * One 代输入 request: a loop of read step → owner answers → act → wait for
 * the screen to settle → read the next step, until the flow ends.
 *
 * The agent never sees steps or values. It only receives the final result.
 */
export class InputHandoffSession {
  private revision = 0;
  private phase: InputHandoffPhase = 'reading';
  private failure: InputHandoffFailure | undefined;
  private target: HandoffTarget | null = null;
  private initial: HandoffTarget | null = null;
  private step: ExtractedStep | null = null;
  private stepNumber = 0;
  private submissions = 0;
  private finishingUntil: number | undefined;
  private finishingTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private agentControlled = false;
  private stayedOn: string | undefined;
  private holder: InputHandoffHolder | undefined;
  private answeredOn: InputHandoffHolder | undefined;
  private ended = false;
  private busy = false;
  private picture: PictureStep | null = null;
  /** The owner chose the screenshot for this flow; stays until they go back to the form. */
  private pictureChosen = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HandoffSessionOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  get requestId(): string {
    return this.options.requestId;
  }

  snapshot(): InputHandoffSnapshot {
    const step = this.step;
    const picture = this.picture && this.phase === 'ready' ? this.picture : null;
    const controls: InputHandoffControl[] = picture
      ? picture.field
        ? [{ id: INPUT_HANDOFF_PICTURE_TEXT_ID, kind: 'text', label: '', contentType: picture.field }]
        : []
      : this.phase === 'ready' || this.phase === 'finishing'
        ? step?.controls ?? []
        : [];
    return {
      kind: 'input_handoff',
      requestId: this.options.requestId,
      revision: this.revision,
      phase: this.phase,
      purpose: this.options.purpose,
      ...(this.options.note ? { note: this.options.note } : {}),
      ...(this.holder ? { holder: { ...this.holder } } : {}),
      ...(this.options.requester ? { requester: this.options.requester } : {}),
      source: this.source(),
      stepNumber: Math.max(1, this.stepNumber),
      controls,
      ...(this.finishingUntil !== undefined && this.phase === 'finishing' ? { finishingUntil: this.finishingUntil } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.agentControlled ? { agentControlled: true as const } : {}),
      ...(this.options.remoteInput && !this.ended ? { remoteInput: true as const } : {}),
      ...(this.ended ? { terminal: true as const } : {}),
      ...(picture ? { picture: true as const } : {}),
      ...(this.liveViewOffered() ? { liveView: true as const } : {}),
      ...(!picture && this.phase === 'ready' && step?.deviceCode ? { deviceCode: { ...step.deviceCode } } : {}),
    };
  }

  private liveViewOffered(): boolean {
    return !this.ended && !!this.target && !!this.options.driver.raise
      && (this.phase === 'ready' || this.phase === 'finishing') && this.options.liveView?.() === true;
  }

  /**
   * The owner opened a live view of the window: bring it to the front and say
   * where it is. Only while this request is waiting for the owner.
   */
  async liveWindow(): Promise<LiveHandoffWindow | null> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.raise || !this.liveViewOffered() || this.busy) return null;
    const raised = await withDesktopTurn(() => driver.raise!(target)).catch(() => null);
    if (!raised || 'error' in raised || this.ended || this.target !== target) return null;
    return {
      pid: target.pid,
      app: target.app,
      ...(target.window.title ? { title: target.window.title } : {}),
      windowId: raised.windowId,
      frame: raised.frame,
    };
  }

  /** The live view closed: read the window again, so the card shows where things are now. */
  async afterLiveView(): Promise<void> {
    if (this.ended || this.busy || this.phase !== 'ready') return;
    await this.decide({ kind: 'input_handoff', action: 'refresh', expectedRevision: this.revision });
  }

  /** The current screenshot, for the executing Desktop and the sealed offer only. */
  pictureFor(revision: number): InputHandoffPicture | null {
    const picture = this.picture;
    if (!picture || !this.isActionable(revision)) return null;
    return { mime: 'image/jpeg', width: picture.width, height: picture.height, data: picture.jpeg.toString('base64') };
  }

  isActionable(revision: number): boolean {
    return !this.ended && !this.busy && this.phase === 'ready' && revision === this.revision;
  }

  async start(): Promise<void> {
    this.publish('reading');
    this.expiryTimer = setTimeout(() => this.end('expired', 'timeout', 'timeout'), this.options.timeoutMs);
    this.expiryTimer.unref?.();
    try {
      const permission = await this.options.driver.permission();
      if (permission !== 'granted') {
        if (permission === 'missing') await this.options.driver.requestPermission();
        if ((await this.options.driver.permission()) !== 'granted') {
          this.end('failed', 'failure', 'permission');
          return;
        }
      }
      const target = this.resolveTarget(await this.options.driver.windows());
      if (!target) {
        this.end('failed', 'failure', 'target_gone');
        return;
      }
      await this.useTarget(target);
      this.initial = target;
      const step = await this.read().catch(() => null);
      if (step && actionable(step)) {
        this.present(step);
        return;
      }
      // Nothing to fill in the window's structure (canvas, self-drawn UI): answer on a picture of it.
      this.step = step;
      if (await this.showPicture()) {
        this.publish('ready');
        return;
      }
      if (!step) {
        this.end('failed', 'failure', 'unreadable');
        return;
      }
      this.present(step);
    } catch {
      this.end('failed', 'failure', 'unreadable');
    }
  }

  /** Owner values. Returns false when the step is no longer the one the owner answered. */
  async submit(submission: InputHandoffSubmission, actor?: InputHandoffHolder): Promise<boolean> {
    if (!this.isActionable(submission.expectedRevision)) return false;
    if (!validateInputHandoffSubmissionForStep(this.snapshot(), submission)) return false;
    if (this.picture) return this.submitPicture(this.picture, submission, actor);
    const current = this.step;
    if (!current) return false;
    this.busy = true;
    // Answering a step is starting to handle it: this device now holds the handoff.
    if (actor) this.holder = actor;
    this.clearFinishing();
    this.failure = undefined;
    this.publish('working');
    const before = { signature: current.signature, windows: await this.options.driver.windows().catch(() => null) };
    let outcome: boolean | 'origin_changed' = false;
    try {
      outcome = await withDesktopTurn(() => this.perform(current, submission));
    } catch {
      outcome = false;
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
    }
    if (this.ended) return true;
    const ok = outcome === true;
    if (outcome !== 'origin_changed') this.submissions++;
    if (ok) this.answeredOn = actor ?? this.answeredOn;
    try {
      const next = await this.awaitSettled(before.signature, before.windows);
      if (this.ended) return true;
      if (next === 'ended') {
        this.end('succeeded', 'detected');
        return true;
      }
      if (outcome !== 'origin_changed') this.stepNumber++;
      if (!ok) this.failure = outcome === 'origin_changed' ? 'origin_changed' : 'action_failed';
      this.present(next, !ok);
    } catch {
      // The next screen cannot be read as a form: show it as a picture instead.
      this.step = null;
      if (!(await this.showPicture().catch(() => false))) this.failure = 'unreadable';
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  async decide(decision: InputHandoffDecision, actor?: InputHandoffHolder): Promise<boolean> {
    if (this.ended || decision.expectedRevision !== this.revision) return false;
    if (decision.action === 'cancel') {
      this.end('cancelled', 'cancelled');
      return true;
    }
    if (decision.action === 'decline') {
      this.end('cancelled', 'declined');
      return true;
    }
    if (decision.action === 'claim') {
      if (!actor || this.busy) return false;
      if (this.holder && sameHolder(this.holder, actor)) return true;
      // Taking over bumps the revision, so an answer already in flight from the
      // previous holder is rejected as stale instead of racing this device.
      this.holder = actor;
      this.publish(this.phase);
      return true;
    }
    if (this.busy) return false;
    if (decision.action === 'done') {
      this.end('succeeded', 'owner');
      return true;
    }
    if (decision.action === 'stay') {
      if (this.phase !== 'finishing') return false;
      this.clearFinishing();
      this.stayedOn = this.step?.signature;
      this.publish('ready');
      return true;
    }
    if (decision.action === 'picture') {
      // The card's form does not match what the owner needs to see (a captcha image, a slider…).
      if (this.phase !== 'ready') return false;
      if (this.picture) return true;
      this.busy = true;
      try {
        this.pictureChosen = true;
        if (await this.showPicture()) this.failure = undefined;
        else {
          this.pictureChosen = false;
          this.failure = 'picture_unavailable';
        }
        this.publish('ready');
      } finally {
        this.busy = false;
      }
      return true;
    }
    // refresh: re-read, following whatever is now in front; from a picture this is "back to the form".
    this.busy = true;
    this.pictureChosen = false;
    try {
      const windows = await this.options.driver.windows().catch(() => null);
      const follow = windows ? this.followTarget(windows, null) : null;
      if (follow === 'ended') {
        this.end('succeeded', 'detected');
        return true;
      }
      if (follow) await this.useTarget(follow);
      const step = await this.read().catch(() => null);
      if (step && (actionable(step) || !this.picture)) {
        this.failure = undefined;
        this.present(step, true);
        return true;
      }
      this.step = step;
      if (await this.showPicture()) this.failure = undefined;
      else {
        this.dropPicture();
        this.failure = 'unreadable';
      }
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  cancel(reason: HandoffEndReason = 'cancelled'): void {
    this.end('cancelled', reason);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private publish(phase: InputHandoffPhase): void {
    this.phase = phase;
    this.revision++;
    this.options.publish(this.snapshot());
  }

  private present(step: ExtractedStep, suppressAutoFinish = false): void {
    this.dropPicture();
    this.step = step;
    if (this.stepNumber === 0) this.stepNumber = 1;
    if (!suppressAutoFinish && this.shouldFinish(step)) {
      this.finishingUntil = this.now() + (this.options.finishingDelayMs ?? 3000);
      this.publish('finishing');
      this.finishingTimer = setTimeout(() => {
        if (this.phase === 'finishing') this.end('succeeded', 'detected');
      }, this.options.finishingDelayMs ?? 3000);
      this.finishingTimer.unref?.();
      return;
    }
    this.publish('ready');
  }

  private shouldFinish(step: ExtractedStep): boolean {
    if (this.stayedOn !== undefined && this.stayedOn === step.signature) return false;
    const hints = this.options.completeWhen;
    if (hints?.textAppears && step.texts.some((text) => text.includes(hints.textAppears!))) return true;
    if (hints?.urlContains && step.url?.includes(hints.urlContains)) return true;
    // A sign-in code is still waiting to be used on the owner's device; they say when they are done.
    if (step.deviceCode) return false;
    // Generic end: after the owner acted, nothing is left to fill or confirm.
    return this.submissions > 0 && !step.hasInputs && !step.hasPrimary;
  }

  /** What the card says it shows: the page when it can be read, otherwise the window. */
  private source(): InputHandoffSource {
    if (this.step) return this.step.source;
    const app = this.target?.app ?? this.options.target.app ?? '';
    return this.target?.window.title ? { app, window: this.target.window.title } : { app };
  }

  /** Photographs the target window for this step. False when the platform or permission does not allow it. */
  private async showPicture(): Promise<boolean> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.capture) return false;
    const shot = await withDesktopTurn(() => driver.capture!(target)).catch(() => null);
    if (!shot || 'error' in shot) return false;
    const focus = await driver.focusedField?.(target.pid).catch(() => null);
    this.dropPicture();
    this.picture = { ...shot, ...(focus?.editable ? { field: focus.secure ? 'password' : 'text' } : {}) };
    if (this.stepNumber === 0) this.stepNumber = 1;
    return true;
  }

  private dropPicture(): void {
    this.picture?.jpeg.fill(0);
    this.picture = null;
  }

  /** One tap, or typing into the focused field, on a screenshot step; then show what came next. */
  private async submitPicture(
    picture: PictureStep,
    submission: InputHandoffSubmission,
    actor?: InputHandoffHolder,
  ): Promise<boolean> {
    this.busy = true;
    if (actor) this.holder = actor;
    this.clearFinishing();
    this.failure = undefined;
    this.publish('working');
    const before = await this.options.driver.windows().catch(() => null);
    let outcome: boolean | 'origin_changed' = false;
    try {
      outcome = await withDesktopTurn(() => this.performPicture(picture, submission));
    } catch {
      outcome = false;
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
    }
    try {
      if (this.ended) return true;
      if (outcome !== 'origin_changed') this.submissions++;
      if (outcome === true) this.answeredOn = actor ?? this.answeredOn;
      const failure: InputHandoffFailure | undefined = outcome === true ? undefined
        : outcome === 'origin_changed' ? 'origin_changed' : 'action_failed';
      await this.sleep(700);
      const windows = await this.options.driver.windows().catch(() => null);
      if (windows) {
        const follow = this.followTarget(windows, before);
        if (follow === 'ended') {
          this.end('succeeded', 'detected');
          return true;
        }
        if (follow) await this.useTarget(follow);
      }
      if (this.ended) return true;
      const step = await this.read().catch(() => null);
      if (step && actionable(step) && !this.pictureChosen) {
        // The screen can be read again: back to the card.
        this.stepNumber++;
        this.failure = failure;
        this.present(step, failure !== undefined);
        return true;
      }
      this.step = step;
      this.failure = failure;
      if (!(await this.showPicture())) {
        this.dropPicture();
        this.failure = 'picture_unavailable';
      }
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  private async performPicture(
    picture: PictureStep,
    submission: InputHandoffSubmission,
  ): Promise<boolean | 'origin_changed'> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.pointer) return false;
    const base = { pid: target.pid, window: target.window, windowFrame: picture.windowFrame };
    const action = submission.action;
    let result: NativeActResult;
    if (action.kind === 'tap') {
      const [x, y, w, h] = picture.area;
      result = await driver.pointer({ kind: 'tap', ...base, area: picture.area, point: [x + action.x * w, y + action.y * h] });
    } else {
      const typed = submission.values[INPUT_HANDOFF_PICTURE_TEXT_ID];
      const value = typeof typed === 'string' ? typed : '';
      if (!picture.field || action.kind === 'press' || (action.kind === 'fill' && !value)) return false;
      const secure = picture.field === 'password';
      result = await driver.pointer({ kind: 'type', ...base, value, submit: action.kind === 'submit', secure });
      if ('ok' in result && result.ok && secure && value && this.agentControlled) {
        this.options.onSecretEntered?.({ pid: target.pid, ...(this.step?.url ? { url: this.step.url } : {}) });
      }
    }
    if ('error' in result && result.error === 'moved') return 'origin_changed';
    return 'ok' in result && result.ok === true;
  }

  private clearFinishing(): void {
    if (this.finishingTimer) clearTimeout(this.finishingTimer);
    this.finishingTimer = undefined;
    this.finishingUntil = undefined;
  }

  private end(status: HandoffResult['status'], reason: HandoffEndReason, failure?: InputHandoffFailure): void {
    if (this.ended) return;
    this.ended = true;
    this.clearFinishing();
    this.dropPicture();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.failure = failure;
    const phase: InputHandoffPhase = status === 'succeeded' ? 'succeeded' : status === 'expired' ? 'expired'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    this.publish(phase);
    this.options.finish({
      status,
      reason,
      steps: this.submissions,
      ...(failure ? { failure } : {}),
      ...(this.target ? { finalApp: this.target.app } : {}),
      ...(this.target?.window.title ? { finalWindow: this.target.window.title.slice(0, 200) } : {}),
      ...(this.step?.source.origin ? { finalOrigin: this.step.source.origin } : {}),
      ...(this.answeredOn ? { answeredOn: { ...this.answeredOn } } : {}),
    });
  }

  private resolveTarget(list: NativeWindowList): HandoffTarget | null {
    const spec = this.options.target;
    const candidates = list.apps.filter((app) => app.pid !== this.options.hostPid && app.windows.some((w) => !w.minimized));
    let app = spec.pid !== undefined ? candidates.find((entry) => entry.pid === spec.pid) : undefined;
    if (!app && spec.app) {
      const wanted = spec.app.trim().toLowerCase();
      app = candidates.find((entry) => entry.app.toLowerCase() === wanted || entry.bundleId.toLowerCase() === wanted)
        ?? candidates.find((entry) => entry.app.toLowerCase().includes(wanted));
    }
    if (!app && spec.pid === undefined && !spec.app) app = candidates.find((entry) => entry.pid === list.frontmost);
    if (!app) return null;
    const visibleWindows = app.windows.filter((window) => !window.minimized);
    const title = spec.windowTitle?.toLowerCase();
    const window = (title ? visibleWindows.find((w) => w.title.toLowerCase().includes(title)) : undefined)
      ?? visibleWindows.find((w) => w.focused)
      ?? visibleWindows[0];
    if (!window) return null;
    return { pid: app.pid, app: app.app, bundleId: app.bundleId, window: { index: window.index, title: window.title } };
  }

  private async useTarget(target: HandoffTarget): Promise<void> {
    if (this.target?.pid !== target.pid) {
      this.agentControlled = AUTOMATION_FLAGS.test(await this.options.driver.commandLine(target.pid));
    }
    this.target = target;
  }

  private async read(): Promise<ExtractedStep | null> {
    if (!this.target) return null;
    const raw = await this.options.driver.snapshot(this.target.pid, this.target.window);
    if ('error' in raw) return null;
    this.target = { ...this.target, window: { index: raw.window.index, title: raw.window.title } };
    const step = extractStep(raw as NativeAxSnapshot);
    await this.loadMissingOptions(step);
    return step;
  }

  /** Pop-ups that do not expose their items are opened briefly to read them. */
  private async loadMissingOptions(step: ExtractedStep): Promise<void> {
    let probed = 0;
    for (const control of step.controls) {
      if (control.kind !== 'choice' || probed >= 4) continue;
      const binding = step.bindings.get(control.id);
      if (binding?.kind !== 'popup' || !binding.needsOptions || !this.target) continue;
      probed++;
      const result = await withDesktopTurn(() => this.options.driver.act({
        pid: this.target!.pid,
        window: this.target!.window,
        ref: binding.ref,
        fp: binding.fp,
        kind: 'options',
      })).catch(() => null);
      if (!result || !('ok' in result) || !result.ok || !result.options?.length) continue;
      control.options = result.options.slice(0, 200).map((label, index) => ({ id: `o${index}`, label: label.slice(0, 300) }));
      binding.optionLabels = new Map(control.options.map((option, index) => [option.id, result.options![index]]));
      delete binding.needsOptions;
    }
  }

  private async act(binding: ControlBinding & { ref: string; fp: string }, kind: 'press' | 'text' | 'pick' | 'key', value?: string): Promise<boolean> {
    if (!this.target) return false;
    const request = { pid: this.target.pid, window: this.target.window, ref: binding.ref, fp: binding.fp, kind, ...(value !== undefined ? { value } : {}) };
    let result: NativeActResult = await this.options.driver.act(request);
    if (!('ok' in result && result.ok) && 'error' in result && result.error === 'stale') {
      // The screen re-rendered; find the same element by identity and retry once.
      const fresh = await this.options.driver.snapshot(this.target.pid, this.target.window);
      if ('error' in fresh) return false;
      const matches = fresh.nodes.filter((node) => node.fp === binding.fp);
      if (matches.length !== 1) return false;
      result = await this.options.driver.act({ ...request, ref: matches[0].ref, window: { index: fresh.window.index, title: fresh.window.title } });
    }
    return 'ok' in result && result.ok === true;
  }

  /** The page a secret is about to go into is still the one the owner was shown. */
  private async sameSurface(step: ExtractedStep): Promise<boolean> {
    if (!this.target) return false;
    const raw = await this.options.driver.snapshot(this.target.pid, this.target.window);
    if ('error' in raw || raw.window.title !== this.target.window.title) return false;
    return extractStep(raw).source.origin === step.source.origin;
  }

  private async perform(step: ExtractedStep, submission: InputHandoffSubmission): Promise<boolean | 'origin_changed'> {
    let lastText: (ControlBinding & { kind: 'text' }) | undefined;
    let secretEntered = false;
    // Secrets are bound to the page the owner saw: re-check it before typing anything in this step.
    const carriesSecret = step.controls.some((control) => {
      const binding = step.bindings.get(control.id);
      return binding?.kind === 'text' && binding.secure && typeof submission.values[control.id] === 'string';
    });
    if (carriesSecret && !(await this.sameSurface(step))) return 'origin_changed';
    for (const control of step.controls) {
      if (!Object.hasOwn(submission.values, control.id)) continue;
      const value = submission.values[control.id];
      const binding = step.bindings.get(control.id);
      if (!binding) return false;
      if (binding.kind === 'text' && typeof value === 'string') {
        if (!(await this.act(binding, 'text', value))) return false;
        if (binding.secure && !secretEntered) {
          secretEntered = true;
          if (this.agentControlled && this.target) {
            this.options.onSecretEntered?.({ pid: this.target.pid, ...(step.url ? { url: step.url } : {}) });
          }
        }
        lastText = binding;
      } else if (binding.kind === 'popup' && typeof value === 'string') {
        const label = binding.optionLabels.get(value);
        if (label === undefined) return false;
        if (control.kind === 'choice' && control.selected === value) continue;
        if (!(await this.act(binding, 'pick', label))) return false;
      } else if (binding.kind === 'radio' && typeof value === 'string') {
        const option = binding.options.get(value);
        if (!option) return false;
        if (control.kind === 'choice' && control.selected === value) continue;
        if (!(await this.act({ kind: 'press', ...option }, 'press'))) return false;
      } else if (binding.kind === 'toggle' && typeof value === 'boolean') {
        if (value !== binding.checked && !(await this.act(binding, 'press'))) return false;
      } else {
        return false;
      }
      await this.sleep(60);
    }
    const action = submission.action;
    if (action.kind === 'press') {
      const binding = step.bindings.get(action.controlId);
      if (binding?.kind !== 'press') return false;
      // Some forms enable their button only after input events settle.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await this.act(binding, 'press')) return true;
        await this.sleep(300);
      }
      return false;
    }
    if (action.kind === 'submit') {
      const field = lastText ?? [...step.bindings.values()].find((b): b is ControlBinding & { kind: 'text' } => b.kind === 'text');
      if (!field) return false;
      return this.act(field, 'key', 'return');
    }
    return true;
  }

  /**
   * Wait until the screen stops changing, following the flow into a new
   * window or another app (for example a browser opened for authorization).
   */
  private async awaitSettled(previous: string, before: NativeWindowList | null): Promise<ExtractedStep | 'ended'> {
    const deadline = this.now() + (this.options.settleTimeoutMs ?? 15_000);
    const start = this.now();
    let last: ExtractedStep | null = null;
    let stableReads = 0;
    await this.sleep(400);
    while (!this.ended) {
      const windows = await this.options.driver.windows().catch(() => null);
      if (windows) {
        const follow = this.followTarget(windows, before);
        if (follow === 'ended') return 'ended';
        if (follow && (follow.pid !== this.target?.pid || follow.window.index !== this.target?.window.index ||
            follow.window.title !== this.target?.window.title)) {
          await this.useTarget(follow);
          last = null;
          stableReads = 0;
        }
      }
      const step = await this.read().catch(() => null);
      if (step) {
        if (last && last.signature === step.signature) stableReads++;
        else stableReads = 0;
        last = step;
        const changed = step.signature !== previous;
        if (stableReads >= 1 && (changed || this.now() - start >= 4000)) return step;
      }
      if (this.now() >= deadline) {
        if (last) return last;
        throw new Error('INPUT_HANDOFF_UNREADABLE');
      }
      await this.sleep(350);
    }
    return last ?? 'ended';
  }

  /** Decide which window the flow now lives in. `'ended'` when nothing remains to follow. */
  private followTarget(list: NativeWindowList, before: NativeWindowList | null): HandoffTarget | 'ended' | null {
    const current = this.target;
    if (!current) return null;
    const hints = this.options.completeWhen;
    const app = (pid: number) => list.apps.find((entry) => entry.pid === pid);
    const toTarget = (entry: NativeWindowList['apps'][number], window: NativeWindowList['apps'][number]['windows'][number]): HandoffTarget => ({
      pid: entry.pid, app: entry.app, bundleId: entry.bundleId, window: { index: window.index, title: window.title },
    });
    // Another app came to the front (for example the browser for an authorization page).
    if (list.frontmost !== current.pid && list.frontmost !== this.options.hostPid) {
      const front = app(list.frontmost);
      const window = front?.windows.find((w) => w.focused && !w.minimized) ?? front?.windows.find((w) => !w.minimized);
      if (front && window) return toTarget(front, window);
    }
    const mine = app(current.pid);
    const sameWindow = mine?.windows.find((w) => w.index === current.window.index && w.title === current.window.title)
      ?? mine?.windows.find((w) => w.title === current.window.title);
    // A new window in the same app took focus (dialogs, popups, sign-in windows).
    const focused = mine?.windows.find((w) => w.focused && !w.minimized);
    if (focused && focused !== sameWindow) {
      const existedBefore = before?.apps.find((entry) => entry.pid === current.pid)?.windows
        .some((w) => w.title === focused.title && w.index === focused.index);
      if (!existedBefore || !sameWindow) return toTarget(mine!, focused);
    }
    if (sameWindow) return null;
    // The window closed.
    if (hints?.windowClosed && this.initial && current.pid === this.initial.pid &&
        current.window.title === this.initial.window.title) return 'ended';
    if (mine) {
      const next = mine.windows.find((w) => w.focused && !w.minimized) ?? mine.windows.find((w) => !w.minimized);
      if (next) return toTarget(mine, next);
    }
    const origin = this.initial && app(this.initial.pid);
    if (origin && origin.pid !== current.pid) {
      const next = origin.windows.find((w) => w.focused && !w.minimized) ?? origin.windows.find((w) => !w.minimized);
      if (next) return toTarget(origin, next);
    }
    return 'ended';
  }
}

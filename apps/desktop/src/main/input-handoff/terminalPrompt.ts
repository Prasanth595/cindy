import {
  validateInputHandoffSubmissionForStep,
  type InputHandoffContentType,
  type InputHandoffControl,
  type InputHandoffDecision,
  type InputHandoffHolder,
  type InputHandoffPhase,
  type InputHandoffSnapshot,
  type InputHandoffSource,
  type InputHandoffSubmission,
} from '@cindy/device-link';
import { classifyOrigin } from './originPolicy.js';
import type { HandoffEndReason, HandoffResult } from './session.js';

/**
 * 代输入 for a password prompt from a terminal program (sudo, ssh, git over
 * HTTPS). The program asked through Cindy's askpass helper; the owner's answer
 * goes straight back to that program and never to the agent, whose command is
 * still running and simply continues.
 */

export type TerminalProgram = 'sudo' | 'ssh' | 'ssh-add' | 'git';

export interface TerminalPromptStep {
  purpose: string;
  source: InputHandoffSource;
  controls: InputHandoffControl[];
  /** Field the owner types into; absent for yes/no confirmations. */
  fieldId?: string;
  /** Button id → literal answer written back to the program. */
  answers: Map<string, string>;
}

const PROMPT_MAX = 300;
const URL_IN_PROMPT = /\bhttps?:\/\/[^\s'"]+/i;

function contentTypeFor(prompt: string, program: TerminalProgram): InputHandoffContentType {
  if (/verification code|one[- ]time|\botp\b|authenticator|token code|验证码/i.test(prompt)) return 'one-time-code';
  if (/^\s*username\b|\buser ?name for\b|^\s*login:/i.test(prompt)) return 'username';
  if (/pass(word|phrase)|\bpin\b|密码|口令/i.test(prompt) || program === 'sudo') return 'password';
  // Anything else a terminal program asks through askpass is treated as secret.
  return 'password';
}

export function buildTerminalPromptStep(rawPrompt: string, program: TerminalProgram): TerminalPromptStep {
  const prompt = rawPrompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, PROMPT_MAX)
    || (program === 'sudo' ? 'Password:' : 'Input:');
  const url = prompt.match(URL_IN_PROMPT)?.[0];
  const { origin, warning } = url ? classifyOrigin(url, true) : {};
  const source: InputHandoffSource = {
    app: program,
    ...(origin ? { origin } : {}),
    ...(warning ? { warning } : {}),
  };
  // ssh asks to trust an unknown host key with a literal yes/no answer.
  if (/\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i.test(prompt)) {
    return {
      purpose: prompt,
      source,
      controls: [
        { id: 'yes', kind: 'button', label: 'yes', primary: true },
        { id: 'no', kind: 'button', label: 'no' },
      ],
      answers: new Map([['yes', 'yes'], ['no', 'no']]),
    };
  }
  return {
    purpose: prompt,
    source,
    controls: [{ id: 'answer', kind: 'text', label: '', contentType: contentTypeFor(prompt, program) }],
    fieldId: 'answer',
    answers: new Map(),
  };
}

export interface TerminalPromptSessionOptions {
  requestId: string;
  prompt: string;
  program: TerminalProgram;
  command: string;
  requester?: string;
  timeoutMs: number;
  remoteInput: boolean;
  publish(snapshot: InputHandoffSnapshot): void;
  finish(result: HandoffResult): void;
  /** Delivers the answer to the waiting program; null makes it fail. Called once. */
  answer(value: string | null): void;
}

function sameHolder(a: InputHandoffHolder, b: InputHandoffHolder): boolean {
  return a.local === true ? b.local === true : b.local !== true && a.deviceId === b.deviceId;
}

export class TerminalPromptSession {
  private revision = 0;
  private phase: InputHandoffPhase = 'ready';
  private holder: InputHandoffHolder | undefined;
  private answeredOn: InputHandoffHolder | undefined;
  private answered = false;
  private failure: HandoffResult['failure'];
  private ended = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly step: TerminalPromptStep;

  constructor(private readonly options: TerminalPromptSessionOptions) {
    this.step = buildTerminalPromptStep(options.prompt, options.program);
  }

  get requestId(): string {
    return this.options.requestId;
  }

  snapshot(): InputHandoffSnapshot {
    return {
      kind: 'input_handoff',
      requestId: this.options.requestId,
      revision: this.revision,
      phase: this.phase,
      purpose: this.step.purpose,
      ...(this.holder ? { holder: { ...this.holder } } : {}),
      ...(this.options.requester ? { requester: this.options.requester } : {}),
      command: this.options.command,
      source: this.step.source,
      stepNumber: 1,
      controls: this.phase === 'ready' ? this.step.controls : [],
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.options.remoteInput && !this.ended ? { remoteInput: true as const } : {}),
      ...(this.ended ? { terminal: true as const } : {}),
    };
  }

  isActionable(revision: number): boolean {
    return !this.ended && this.phase === 'ready' && revision === this.revision;
  }

  async start(): Promise<void> {
    this.publish('ready');
    this.expiryTimer = setTimeout(() => this.end('expired', 'timeout', 'timeout'), this.options.timeoutMs);
    this.expiryTimer.unref?.();
  }

  async submit(submission: InputHandoffSubmission, actor?: InputHandoffHolder): Promise<boolean> {
    if (!this.isActionable(submission.expectedRevision)) return false;
    if (!validateInputHandoffSubmissionForStep(this.snapshot(), submission)) return false;
    let value: string | undefined;
    try {
      if (this.step.fieldId) {
        const typed = submission.values[this.step.fieldId];
        if (typeof typed !== 'string' || submission.action.kind === 'press') return false;
        value = typed;
      } else {
        if (submission.action.kind !== 'press') return false;
        value = this.step.answers.get(submission.action.controlId);
      }
      if (value === undefined) return false;
      this.answeredOn = actor ?? { local: true };
      this.deliver(value);
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
      value = undefined;
    }
    this.end('succeeded', 'owner');
    return true;
  }

  async decide(decision: InputHandoffDecision, actor?: InputHandoffHolder): Promise<boolean> {
    if (this.ended || decision.expectedRevision !== this.revision) return false;
    switch (decision.action) {
      case 'cancel':
      case 'done':
        this.end('cancelled', 'cancelled');
        return true;
      case 'decline':
        this.end('cancelled', 'declined');
        return true;
      case 'claim':
        if (!actor) return false;
        if (this.holder && sameHolder(this.holder, actor)) return true;
        this.holder = actor;
        this.publish(this.phase);
        return true;
      case 'refresh':
        this.publish(this.phase);
        return true;
      default:
        return false;
    }
  }

  cancel(reason: HandoffEndReason = 'cancelled'): void {
    this.end('cancelled', reason);
  }

  /** The asking program went away (finished, killed or timed out on its side). */
  abandon(): void {
    this.answered = true;
    this.end('failed', 'failure', 'target_gone');
  }

  private deliver(value: string | null): void {
    if (this.answered) return;
    this.answered = true;
    this.options.answer(value);
  }

  private publish(phase: InputHandoffPhase): void {
    this.phase = phase;
    this.revision++;
    this.options.publish(this.snapshot());
  }

  private end(status: HandoffResult['status'], reason: HandoffEndReason, failure?: HandoffResult['failure']): void {
    if (this.ended) return;
    this.ended = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.failure = failure;
    this.deliver(null);
    const phase: InputHandoffPhase = status === 'succeeded' ? 'succeeded' : status === 'expired' ? 'expired'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    this.publish(phase);
    this.options.finish({
      status,
      reason,
      steps: status === 'succeeded' ? 1 : 0,
      ...(failure ? { failure } : {}),
      finalApp: this.options.program,
      ...(this.step.source.origin ? { finalOrigin: this.step.source.origin } : {}),
      ...(this.answeredOn ? { answeredOn: { ...this.answeredOn } } : {}),
    });
  }
}

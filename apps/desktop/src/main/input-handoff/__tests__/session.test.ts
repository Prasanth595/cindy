import { describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import { fakeDesktop } from './fakeDesktop.js';

function harness(driver: HandoffDriver, extra: Partial<ConstructorParameters<typeof InputHandoffSession>[0]> = {}) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in to Example',
    target: { app: 'Example' },
    timeoutMs: 600_000,
    hostPid: 1,
    remoteInput: true,
    driver,
    publish: (snapshot) => published.push(snapshot),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    finishingDelayMs: 5,
    ...extra,
  });
  const latest = () => published[published.length - 1];
  return { session, published, finished, latest };
}

describe('InputHandoffSession', () => {
  it('walks an unknown multi-step flow across apps and finishes on its own', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    let step = latest();
    expect(step.phase).toBe('ready');
    const choice = step.controls.find((control) => control.kind === 'choice')!;
    const next = step.controls.find((control) => control.kind === 'button')!;
    expect(await session.submit({ expectedRevision: step.revision, values: { [choice.id]: 'o1' }, action: { kind: 'press', controlId: next.id } })).toBe(true);

    step = latest();
    expect(step.stepNumber).toBe(2);
    const org = step.controls.find((control) => control.kind === 'text')!;
    const go = step.controls.find((control) => control.kind === 'button')!;
    await session.submit({ expectedRevision: step.revision, values: { [org.id]: 'acme' }, action: { kind: 'press', controlId: go.id } });

    step = latest();
    expect(step.source).toMatchObject({ app: 'Google Chrome', origin: 'https://auth.example.com' });
    const authorize = step.controls.find((control) => control.kind === 'button' && control.label === 'Authorize')!;
    expect(authorize).toMatchObject({ primary: true });
    await session.submit({ expectedRevision: step.revision, values: {}, action: { kind: 'press', controlId: authorize.id } });

    expect(latest().phase).toBe('finishing');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'detected', steps: 3, finalApp: 'Example' });
    expect(latest()).toMatchObject({ phase: 'succeeded', terminal: true });
    expect(desktop.acts.find((act) => act.kind === 'text')?.value).toBe('acme');
    expect(JSON.stringify(finished)).not.toContain('acme');
    expect(JSON.stringify(latest())).not.toContain('acme');
  });

  it('rejects stale or foreign submissions', async () => {
    const { session, latest } = harness(fakeDesktop().driver);
    await session.start();
    const step = latest();
    const button = step.controls.find((control) => control.kind === 'button')!;
    expect(await session.submit({ expectedRevision: step.revision - 1, values: {}, action: { kind: 'press', controlId: button.id } })).toBe(false);
    expect(await session.submit({ expectedRevision: step.revision, values: { nope: 'x' }, action: { kind: 'press', controlId: button.id } })).toBe(false);
    expect(await session.submit({ expectedRevision: step.revision, values: {}, action: { kind: 'press', controlId: 'c999' } })).toBe(false);
  });

  it('lets the owner stay, hand back or cancel', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver, { finishingDelayMs: 60_000 });
    await session.start();
    // Jump to the end state to test the countdown controls.
    const choose = latest();
    const button = choose.controls.find((control) => control.kind === 'button')!;
    await session.submit({ expectedRevision: choose.revision, values: {}, action: { kind: 'press', controlId: button.id } });
    const org = latest();
    await session.submit({ expectedRevision: org.revision, values: {}, action: { kind: 'press', controlId: org.controls.find((c) => c.kind === 'button')!.id } });
    const consent = latest();
    await session.submit({ expectedRevision: consent.revision, values: {}, action: { kind: 'press', controlId: consent.controls.find((c) => c.kind === 'button' && c.label === 'Authorize')!.id } });
    expect(latest().phase).toBe('finishing');
    expect(await session.decide({ kind: 'input_handoff', action: 'stay', expectedRevision: latest().revision })).toBe(true);
    expect(latest().phase).toBe('ready');
    expect(await session.decide({ kind: 'input_handoff', action: 'done', expectedRevision: latest().revision })).toBe(true);
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'owner' });
    expect(await session.decide({ kind: 'input_handoff', action: 'cancel', expectedRevision: latest().revision })).toBe(false);
  });

  it('fails clearly without accessibility permission or target', async () => {
    const desktop = fakeDesktop();
    const noPermission = harness({ ...desktop.driver, permission: async () => 'missing' });
    await noPermission.session.start();
    expect(noPermission.finished[0]).toMatchObject({ status: 'failed', failure: 'permission' });
    const noTarget = harness(desktop.driver, { target: { app: 'Missing App' } });
    await noTarget.session.start();
    expect(noTarget.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
    const host = harness(desktop.driver, { target: { pid: 1 } });
    await host.session.start();
    expect(host.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
  });

  it('flags agent-controlled browsers', async () => {
    const desktop = fakeDesktop();
    const { session, latest } = harness({ ...desktop.driver, commandLine: async () => 'Chromium --remote-debugging-port=9222' });
    await session.start();
    expect(latest().agentControlled).toBe(true);
  });
});

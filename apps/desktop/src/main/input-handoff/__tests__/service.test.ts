import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import {
  inputHandoffRecordMessage,
  parseInputHandoffEndRecord,
  UI_ACTION_TRIGGER_PREFIX,
} from '@cindy/maker-shared/synthetic-trigger';
import { INPUT_HANDOFF_MAX_PER_TASK, InputHandoffService } from '../service.js';
import { readInputHandoffSetting } from '../botPolicy.js';
import { fakeDesktop } from './fakeDesktop.js';

const services: InputHandoffService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.cleanupAll()));

function harness() {
  const desktop = fakeDesktop();
  const snapshots: InputHandoffSnapshot[] = [];
  const continued: string[] = [];
  let clock = 0;
  const service = new InputHandoffService({
    broadcast: (_channel, payload) => {
      const request = (payload as { request?: InputHandoffSnapshot }).request;
      if (request) snapshots.push(request);
    },
    createDriver: () => desktop.driver,
    hostPid: 1,
    remoteInputAvailable: () => true,
    continueAgent: async (_session, _request, message) => {
      continued.push(message);
    },
    describeDevice: (deviceId) => (deviceId === 'phone-1' ? { name: 'Synthetic Phone', platform: 'mobile' } : {}),
    terminalRetentionMs: 0,
    sessionTiming: { now: () => clock, sleep: async (ms) => { clock += ms; }, finishingDelayMs: 5 },
  });
  services.push(service);
  const latest = () => snapshots[snapshots.length - 1];
  return { desktop, service, latest, continued, advance: (ms: number) => { clock += ms; } };
}

async function startReady(h: ReturnType<typeof harness>, sessionId = 'task') {
  const started = h.service.start({ sessionId, purpose: 'Sign in to Example', note: 'Not sure which option', target: { app: 'Example' } });
  if (!started.ok) throw new Error(started.errorCode);
  await vi.waitFor(() => expect(h.latest()?.phase).toBe('ready'));
  return started.requestId;
}

describe('代输入 owner controls', () => {
  it('shows the agent note and records which device holds the handoff', async () => {
    const h = harness();
    const requestId = await startReady(h);
    expect(h.latest().note).toBe('Not sure which option');
    expect(h.latest().holder).toBeUndefined();

    const before = h.latest().revision;
    expect(h.service.resolve(requestId, { kind: 'input_handoff', action: 'claim', expectedRevision: before }, { deviceId: 'phone-1' })).toBe(true);
    await vi.waitFor(() => expect(h.latest().holder).toEqual({ deviceId: 'phone-1', name: 'Synthetic Phone', platform: 'mobile' }));
    // Taking over invalidates an answer prepared for the previous revision.
    expect(h.latest().revision).toBeGreaterThan(before);

    const step = h.latest();
    const choice = step.controls.find((c) => c.kind === 'choice')!;
    const next = step.controls.find((c) => c.kind === 'button')!;
    expect(await h.service.submit(requestId, { expectedRevision: before, values: { [choice.id]: 'o1' }, action: { kind: 'press', controlId: next.id } })).toBe(false);

    // The host Desktop takes it back by answering.
    expect(await h.service.submit(requestId, { expectedRevision: step.revision, values: { [choice.id]: 'o1' }, action: { kind: 'press', controlId: next.id } })).toBe(true);
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
    expect(h.latest().holder).toEqual({ local: true });
  });

  it('turns the end into a value-free record line naming the answering device', async () => {
    const h = harness();
    const requestId = await startReady(h);
    const step = h.latest();
    const choice = step.controls.find((c) => c.kind === 'choice')!;
    const next = step.controls.find((c) => c.kind === 'button')!;
    await h.service.submit(requestId, { expectedRevision: step.revision, values: { [choice.id]: 'o1' }, action: { kind: 'press', controlId: next.id } }, { deviceId: 'phone-1' });
    await vi.waitFor(() => expect(h.latest().stepNumber).toBe(2));
    h.service.resolve(requestId, { kind: 'input_handoff', action: 'done', expectedRevision: h.latest().revision });
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));

    const record = parseInputHandoffEndRecord(`${UI_ACTION_TRIGGER_PREFIX}${h.continued[0]}`)!;
    expect(record).toMatchObject({ status: 'succeeded', declined: false, steps: 1, answeredOn: { kind: 'named', name: 'Synthetic Phone' } });
    expect(inputHandoffRecordMessage(record)).toEqual({ key: 'doneOn', params: { count: 1, device: 'Synthetic Phone' } });
  });

  it('stops asking in a task after the owner declines', async () => {
    const h = harness();
    const requestId = await startReady(h);
    h.service.resolve(requestId, { kind: 'input_handoff', action: 'decline', expectedRevision: h.latest().revision });
    await vi.waitFor(() => expect(h.continued).toHaveLength(1));
    expect(h.continued[0]).toContain('ended_by=declined');
    expect(parseInputHandoffEndRecord(h.continued[0])).toMatchObject({ status: 'cancelled', declined: true });

    expect(h.service.start({ sessionId: 'task', purpose: 'Again', target: { app: 'Example' } })).toMatchObject({ ok: false, errorCode: 'DECLINED' });
    // Other tasks are unaffected.
    expect(h.service.start({ sessionId: 'other', purpose: 'Sign in', target: { app: 'Example' } }).ok).toBe(true);
  });

  it('limits how often one task can page the owner', async () => {
    const h = harness();
    for (let i = 0; i < INPUT_HANDOFF_MAX_PER_TASK; i++) {
      const requestId = await startReady(h);
      h.service.resolve(requestId, { kind: 'input_handoff', action: 'cancel', expectedRevision: h.latest().revision });
      await vi.waitFor(() => expect(h.continued).toHaveLength(i + 1));
    }
    expect(h.service.start({ sessionId: 'task', purpose: 'Again', target: { app: 'Example' } })).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    h.advance(60 * 60_000);
    expect(h.service.start({ sessionId: 'task', purpose: 'Later', target: { app: 'Example' } }).ok).toBe(true);
  });
});

describe('teammate 代输入 setting', () => {
  it('is on unless the owner explicitly turned it off', () => {
    expect(readInputHandoffSetting('{}')).toBe(true);
    expect(readInputHandoffSetting('{"inputHandoff":true}')).toBe(true);
    expect(readInputHandoffSetting('{"inputHandoff":false}')).toBe(false);
    expect(readInputHandoffSetting('not json')).toBe(true);
  });
});

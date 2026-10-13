import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '../inputHandoff.js';
import {
  INPUT_HANDOFF_PICTURE_MAX_BYTES,
  INPUT_HANDOFF_PICTURE_MAX_SIDE,
  inputHandoffHeldElsewhere,
  inputHandoffPresentation,
  inputHandoffStepKey,
  parseInputHandoffDecision,
  parseInputHandoffOffer,
  parseInputHandoffPicture,
  parseInputHandoffPresentation,
  parseInputHandoffSubmission,
  validateInputHandoffSubmissionForStep,
} from '../inputHandoff.js';

const controls: InputHandoffSnapshot['controls'] = [
  { id: 'c0', kind: 'text', label: 'Email', contentType: 'email' },
  { id: 'c1', kind: 'button', label: 'Next', primary: true },
];

describe('代输入 holder', () => {
  it('is free for everyone until a device starts handling it', () => {
    expect(inputHandoffHeldElsewhere({}, { local: true })).toBe(false);
    expect(inputHandoffHeldElsewhere({}, { deviceId: 'phone-1' })).toBe(false);
  });

  it('tells each device whether someone else is handling it', () => {
    const onPhone = { holder: { deviceId: 'phone-1' } };
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: 'phone-1' })).toBe(false);
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: 'desk-2' })).toBe(true);
    expect(inputHandoffHeldElsewhere(onPhone, { local: true })).toBe(true);
    // A device without a known id can never be mistaken for the holder.
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: null })).toBe(true);

    const onHost = { holder: { local: true as const } };
    expect(inputHandoffHeldElsewhere(onHost, { local: true })).toBe(false);
    expect(inputHandoffHeldElsewhere(onHost, { deviceId: 'phone-1' })).toBe(true);
  });

  it('accepts take-over and decline as value-less decisions', () => {
    for (const action of ['claim', 'decline'] as const) {
      expect(parseInputHandoffDecision({ kind: 'input_handoff', action, expectedRevision: 3 })).toEqual({
        kind: 'input_handoff',
        action,
        expectedRevision: 3,
      });
    }
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'steal', expectedRevision: 3 })).toBeNull();
  });
});

describe('代输入 step key', () => {
  const base = { requestId: 'req1', stepNumber: 1, controls };

  it('stays the same when only the revision moves, so a take-over keeps the draft', () => {
    expect(inputHandoffStepKey(base)).toBe(inputHandoffStepKey({ ...base, controls: controls.map((c) => ({ ...c })) }));
  });

  it('changes for a new step or a different screen', () => {
    expect(inputHandoffStepKey({ ...base, stepNumber: 2 })).not.toBe(inputHandoffStepKey(base));
    const password: InputHandoffSnapshot['controls'] = [
      { id: 'c0', kind: 'text', label: 'Password', contentType: 'password' },
      controls[1]!,
    ];
    expect(inputHandoffStepKey({ ...base, controls: password })).not.toBe(inputHandoffStepKey(base));
  });

  it('gives a screenshot step its own key, so a form draft never carries over', () => {
    expect(inputHandoffStepKey({ ...base, picture: true })).not.toBe(inputHandoffStepKey(base));
  });
});

describe('代输入 screenshot step', () => {
  const picture = { mime: 'image/jpeg', width: 640, height: 400, data: 'AAAA' };
  const presentation = {
    requestId: 'req1',
    revision: 4,
    purpose: 'Sign in',
    source: { app: 'Chrome' },
    command: null,
    controls: [{ id: 'typed', kind: 'text', label: '' }],
    picture: true,
  };
  const state = 'a'.repeat(43);

  it('accepts a bounded JPEG and nothing else', () => {
    expect(parseInputHandoffPicture(picture)).toEqual(picture);
    for (const bad of [
      { ...picture, mime: 'image/png' },
      { ...picture, width: 0 },
      { ...picture, height: INPUT_HANDOFF_PICTURE_MAX_SIDE + 1 },
      { ...picture, data: '' },
      { ...picture, data: 'not base64!' },
      { ...picture, data: 'A'.repeat(Math.ceil(INPUT_HANDOFF_PICTURE_MAX_BYTES / 3) * 4 + 4) },
      { ...picture, extra: 1 },
    ])
      expect(() => parseInputHandoffPicture(bad)).toThrow();
  });

  it('carries the picture exactly when the presentation says it is a screenshot step', () => {
    expect(parseInputHandoffOffer({ kind: 'input-entry', state, presentation, picture }).picture).toEqual(picture);
    expect(() => parseInputHandoffOffer({ kind: 'input-entry', state, presentation })).toThrow();
    const form = { ...presentation, picture: false };
    expect(() => parseInputHandoffOffer({ kind: 'input-entry', state, presentation: form, picture })).toThrow();
    expect(parseInputHandoffOffer({ kind: 'input-entry', state, presentation: form }).picture).toBeUndefined();
  });

  it('requires the picture flag in every presentation', () => {
    const { picture: _flag, ...withoutFlag } = presentation;
    expect(() => parseInputHandoffPresentation(withoutFlag)).toThrow();
  });

  it('marks the presentation as a screenshot step without carrying pixels', () => {
    const snapshot = {
      requestId: 'req1',
      revision: 4,
      purpose: 'Sign in',
      source: { app: 'Chrome' },
      controls: [{ id: 'typed', kind: 'text', label: '', contentType: 'password' }],
      picture: true,
    } as unknown as InputHandoffSnapshot;
    expect(inputHandoffPresentation(snapshot)).toEqual(presentation);
  });

  it('parses a tap as fractions of the picture', () => {
    const tap = (action: unknown) => parseInputHandoffSubmission({ expectedRevision: 4, values: {}, action });
    expect(tap({ kind: 'tap', x: 0.25, y: 1 }).action).toEqual({ kind: 'tap', x: 0.25, y: 1 });
    for (const action of [
      { kind: 'tap', x: -0.1, y: 0.5 },
      { kind: 'tap', x: 0.5, y: 1.2 },
      { kind: 'tap', x: '0.5', y: 0.5 },
      { kind: 'tap', x: 0.5 },
      { kind: 'tap', x: 0.5, y: 0.5, button: 'right' },
    ])
      expect(() => tap(action)).toThrow();
  });

  it('allows a tap only on a screenshot step, and only without values', () => {
    const form = { revision: 4, controls: [{ id: 'typed', kind: 'text' as const, label: '', contentType: 'text' as const }] };
    const shot = { ...form, picture: true as const };
    const tap = { kind: 'tap', x: 0.5, y: 0.5 } as const;
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: {}, action: tap })).toBe(true);
    expect(validateInputHandoffSubmissionForStep(form, { expectedRevision: 4, values: {}, action: tap })).toBe(false);
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: { typed: 'x' }, action: tap })).toBe(false);
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 3, values: {}, action: tap })).toBe(false);
    expect(
      validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: { typed: 'hello' }, action: { kind: 'submit' } }),
    ).toBe(true);
  });

  it('accepts asking for the picture as a value-less decision', () => {
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'picture', expectedRevision: 2 })?.action).toBe('picture');
  });
});

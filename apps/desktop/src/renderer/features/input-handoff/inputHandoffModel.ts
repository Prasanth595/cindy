import type {
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from '@cindy/device-link';

/**
 * 代输入 card model. The snapshot carries step structure only; values the
 * owner types live in the card's local state and leave only through
 * makerTransport.submitInputHandoff.
 */

const PHASES = new Set([
  'reading',
  'ready',
  'working',
  'finishing',
  'succeeded',
  'cancelled',
  'failed',
  'expired',
]);

/** Light shape check for pushes; the Host is the authority for every field. */
export function parsePendingInputHandoff(raw: unknown): InputHandoffSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const source = v.source as Record<string, unknown> | undefined;
  if (
    v.kind !== 'input_handoff' ||
    typeof v.requestId !== 'string' ||
    !v.requestId ||
    !Number.isSafeInteger(v.revision) ||
    !PHASES.has(String(v.phase)) ||
    typeof v.purpose !== 'string' ||
    !Array.isArray(v.controls) ||
    !source ||
    typeof source.app !== 'string'
  )
    return null;
  return raw as InputHandoffSnapshot;
}

export function isInputHandoffAwaitingOwner(snapshot: InputHandoffSnapshot | null): boolean {
  return !!snapshot && snapshot.terminal !== true;
}

export type InputHandoffInteractive = Exclude<InputHandoffControl, { kind: 'note' }>;

export function interactiveControls(snapshot: InputHandoffSnapshot): InputHandoffInteractive[] {
  return snapshot.controls.filter(
    (control): control is InputHandoffInteractive => control.kind !== 'note',
  );
}

/**
 * Initial draft for a step: choices start at the screen's current selection
 * and toggles at their current state. Text starts empty — current text is
 * never sent to the card.
 */
export function initialDraft(snapshot: InputHandoffSnapshot): InputHandoffValues {
  const draft: InputHandoffValues = {};
  for (const control of snapshot.controls) {
    if (control.kind === 'choice' && control.selected) draft[control.id] = control.selected;
    if (control.kind === 'toggle') draft[control.id] = control.checked;
  }
  return draft;
}

/** Only values the owner actually changed are applied to the screen. */
export function changedValues(
  snapshot: InputHandoffSnapshot,
  draft: InputHandoffValues,
): InputHandoffValues {
  const initial = initialDraft(snapshot);
  const out: InputHandoffValues = {};
  for (const control of interactiveControls(snapshot)) {
    const value = draft[control.id];
    if (value === undefined) continue;
    if (control.kind === 'text' && value === '') continue;
    if (control.kind !== 'text' && value === initial[control.id]) continue;
    out[control.id] = value;
  }
  return out;
}

/** Standard platform autofill hints so password managers recognize the field. */
export function autoCompleteFor(control: Extract<InputHandoffControl, { kind: 'text' }>): string {
  switch (control.contentType) {
    case 'password':
      return 'current-password';
    case 'one-time-code':
      return 'one-time-code';
    case 'username':
      return 'username';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    default:
      return 'off';
  }
}

export function inputTypeFor(control: Extract<InputHandoffControl, { kind: 'text' }>): string {
  switch (control.contentType) {
    case 'password':
      return 'password';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    case 'search':
      return 'search';
    default:
      return 'text';
  }
}

export function inputModeFor(
  control: Extract<InputHandoffControl, { kind: 'text' }>,
): 'numeric' | 'email' | 'tel' | 'url' | 'text' {
  switch (control.contentType) {
    case 'one-time-code':
    case 'number':
      return 'numeric';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    default:
      return 'text';
  }
}

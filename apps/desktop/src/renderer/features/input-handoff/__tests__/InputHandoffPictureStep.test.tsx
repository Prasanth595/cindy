// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';

import { InputHandoffCard } from '../InputHandoffCard';

const mocks = vi.hoisted(() => ({
  answer: vi.fn(async () => ({ accepted: true })),
  close: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(async () => ({ accepted: true })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => 'this-device',
}));
vi.mock('@/lib/makerTransport', () => ({
  submitInputHandoff: vi.fn(),
  openInputHandoffPicture: mocks.open,
  makerApiForSticky: () => ({ resolveInteraction: mocks.resolve }),
}));

beforeEach(() => {
  mocks.open.mockImplementation(async () => ({
    picture: { mime: 'image/jpeg', width: 800, height: 600, data: 'AAAA' },
    answer: mocks.answer,
    close: mocks.close,
  }));
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

let nextRequest = 0;
const shot = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: 'input_handoff',
  requestId: `req${nextRequest}`,
  revision: 4,
  phase: 'ready',
  purpose: 'Sign in to Game',
  source: { app: 'Game', window: 'Game' },
  stepNumber: 1,
  remoteInput: true,
  controls: [],
  picture: true,
  ...overrides,
});

describe('InputHandoffCard screenshot step', () => {
  beforeEach(() => {
    nextRequest++;
  });

  it('shows the picture right away on the executing computer and sends a tap as a fraction', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    const image = await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    expect(mocks.open).toHaveBeenCalledWith('s1', expect.objectContaining({ picture: true, revision: 4 }));
    fireEvent.click(image, { clientX: 110, clientY: 245 });
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledWith({
      expectedRevision: 4,
      values: {},
      action: { kind: 'tap', x: 0.25, y: 0.75 },
    }));
    // No quiet take-over: that would move the revision under the picture.
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('asks before fetching the picture for a task on another computer', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} remote />);
    expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.picture.open' }));
    await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('types into the focused field with the platform password field', async () => {
    const snapshot = shot({ controls: [{ id: 'typed', kind: 'text', label: '', contentType: 'password' }] });
    render(<InputHandoffCard sessionId="s1" snapshot={snapshot} />);
    const field = (await screen.findByLabelText('inputHandoff.passwordField')) as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'synthetic-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.picture.typeEnter' }));
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledWith({
      expectedRevision: 4,
      values: { typed: 'synthetic-pass' },
      action: { kind: 'submit' },
    }));
    await waitFor(() => expect(field.value).toBe(''));
  });

  it('closes the exchange when the step moves on and opens the next one by itself', async () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={shot()} remote />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.picture.open' }));
    await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    rerender(<InputHandoffCard sessionId="s1" snapshot={shot({ revision: 6 })} remote />);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(mocks.open).toHaveBeenLastCalledWith('s1', expect.objectContaining({ revision: 6 }));
  });

  it('goes back to the form with a value-less decision', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.backToForm' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(expect.any(String), {
      kind: 'input_handoff',
      action: 'refresh',
      expectedRevision: 4,
    }));
  });

  it('offers the picture from a form step', async () => {
    const form = shot({
      picture: undefined,
      controls: [{ id: 'c0', kind: 'button', label: 'Continue', primary: true }],
    });
    render(<InputHandoffCard sessionId="s1" snapshot={form} />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.picture' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(form.requestId, {
      kind: 'input_handoff',
      action: 'picture',
      expectedRevision: 4,
    }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

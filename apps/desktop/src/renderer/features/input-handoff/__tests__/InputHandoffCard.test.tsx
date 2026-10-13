// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';

import { InputHandoffCard } from '../InputHandoffCard';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ accepted: true })),
  resolve: vi.fn(async () => ({ accepted: true })),
  deviceId: null as string | null,
  hostDeviceId: undefined as string | undefined,
  openRemoteDesktop: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => mocks.deviceId,
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => mocks.hostDeviceId,
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'mac', name: 'Studio' }],
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/makerTransport', () => ({
  submitInputHandoff: mocks.submit,
  makerApiForSticky: () => ({ resolveInteraction: mocks.resolve }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.deviceId = null;
  mocks.hostDeviceId = undefined;
});

const step = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: 'input_handoff',
  requestId: 'req1',
  revision: 4,
  phase: 'ready',
  purpose: 'Sign in to Example',
  source: { app: 'Example', window: 'Sign in' },
  stepNumber: 1,
  remoteInput: true,
  controls: [
    { id: 'c0', kind: 'text', label: 'Email', contentType: 'email' },
    { id: 'c1', kind: 'text', label: 'Password', contentType: 'password' },
    { id: 'c2', kind: 'button', label: 'Sign In', primary: true },
  ],
  ...overrides,
});

describe('InputHandoffCard', () => {
  it('renders standard autofill fields so password managers can fill them', () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('email');
  });

  it('sends only what the owner typed with the pressed button, then clears it', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'synthetic-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        submission: {
          expectedRevision: 4,
          values: { c1: 'synthetic-pass' },
          action: { kind: 'press', controlId: 'c2' },
        },
      }),
    );
    await waitFor(() => expect(password.value).toBe(''));
  });

  it('hands back with a value-less decision', async () => {
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({ phase: 'finishing', finishingUntil: Date.now() + 3000 })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.done' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', {
        kind: 'input_handoff',
        action: 'done',
        expectedRevision: 4,
      }),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('starts a new screen from an empty draft', () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.test' } });
    rerender(<InputHandoffCard sessionId="s1" snapshot={step({ revision: 5, stepNumber: 2 })} />);
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
  });

  it('starts handling quietly on the first keystroke without blocking the form', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'so' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    expect(mocks.resolve).toHaveBeenCalledWith('req1', {
      kind: 'input_handoff',
      action: 'claim',
      expectedRevision: 4,
    });
    expect((screen.getByLabelText('Email') as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps what the owner is typing when another device was taken over', () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.test' } });
    rerender(
      <InputHandoffCard sessionId="s1" snapshot={step({ revision: 5, holder: { local: true } })} />,
    );
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('someone@example.test');
  });

  it('shows who is handling it elsewhere and lets this device take over', async () => {
    mocks.deviceId = 'desk-2';
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({
          holder: { deviceId: 'phone-1', name: 'Synthetic Phone', platform: 'mobile' },
        })}
      />,
    );
    expect(screen.getByText('inputHandoff.holder.elsewhere')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.claim' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', {
        kind: 'input_handoff',
        action: 'claim',
        expectedRevision: 4,
      }),
    );
  });

  it('shows a terminal password prompt as one answer to one program', async () => {
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({
          purpose: '[sudo] password for someone:',
          source: { app: 'sudo' },
          command: 'sudo -A true',
          controls: [{ id: 'answer', kind: 'text', label: '', contentType: 'password' }],
        })}
      />,
    );
    expect(screen.getByText('sudo -A true')).toBeTruthy();
    const field = screen.getByLabelText('inputHandoff.passwordField') as HTMLInputElement;
    expect(field.type).toBe('password');
    for (const hidden of ['refresh', 'done', 'fill']) {
      expect(screen.queryByRole('button', { name: `inputHandoff.action.${hidden}` })).toBeNull();
    }
    fireEvent.change(field, { target: { value: 'synthetic-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.submit' }));
    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          submission: {
            expectedRevision: 4,
            values: { answer: 'synthetic-pass' },
            action: { kind: 'submit' },
          },
        }),
      ),
    );
  });

  it('lets the owner stop this task from asking again', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.decline' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', {
        kind: 'input_handoff',
        action: 'decline',
        expectedRevision: 4,
      }),
    );
  });

  it('opens a live view of just this window on the computer running the task', async () => {
    (window as unknown as { electronAPI: object }).electronAPI = {
      openRemoteDesktop: mocks.openRemoteDesktop,
    };
    const { rerender } = render(
      <InputHandoffCard sessionId="s1" snapshot={step({ liveView: true })} />,
    );
    // A task on this computer: the window is right here.
    expect(screen.queryByRole('button', { name: 'inputHandoff.action.liveView' })).toBeNull();
    mocks.hostDeviceId = 'mac';
    rerender(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    expect(screen.queryByRole('button', { name: 'inputHandoff.action.liveView' })).toBeNull();
    rerender(<InputHandoffCard sessionId="s1" snapshot={step({ liveView: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.liveView' }));
    await waitFor(() =>
      expect(mocks.openRemoteDesktop).toHaveBeenCalledWith({
        deviceId: 'mac',
        name: 'Studio',
        handoff: 'req1',
      }),
    );
  });

  it('offers a sign-in code to copy and its link to open on this device', async () => {
    const openExternal = vi.fn(async () => ({ success: true }));
    const writeText = vi.fn(async () => {});
    (window as unknown as { electronAPI: object }).electronAPI = { openExternal };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const codeStep = step({
      controls: [{ id: 'c0', kind: 'note', tone: 'info', text: 'Open github.com/login/device and enter WDJB-MJHT' }],
      deviceCode: { code: 'WDJB-MJHT', url: 'https://github.com/login/device', origin: 'https://github.com' },
    });
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={codeStep} />);
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.deviceCode.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('WDJB-MJHT'));
    fireEvent.click(screen.getByRole('button', { name: /inputHandoff\.deviceCode\.open/ }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device'));
    // A link whose shown origin does not match is never offered.
    rerender(
      <InputHandoffCard
        sessionId="s1"
        snapshot={{ ...codeStep, deviceCode: { ...codeStep.deviceCode!, origin: 'https://example.com' } }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'inputHandoff.deviceCode.copy' })).toBeNull();
  });
});

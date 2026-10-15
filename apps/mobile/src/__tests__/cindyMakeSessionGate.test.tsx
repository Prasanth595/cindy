// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate } from '@/session/CindyMakeSessionGate';

const state = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; source?: string; deviceLinkDeviceId?: string }>,
  listeners: new Set<() => void>(),
  maker: { getSession: vi.fn() },
  openLink: vi.fn(),
  connectionEpoch: 0,
  accountGeneration: 1,
}));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessions: () => state.sessions,
  getSessionDeviceId: (sessionId: string) => state.sessions.find(session => session.id === sessionId)?.deviceLinkDeviceId,
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: state.accountGeneration }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  openLink: state.openLink,
  connectionEpoch: state.connectionEpoch,
}) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => state.maker }));
vi.mock('expo-router', () => ({ Redirect: ({ href }: { href: string }) => createElement('span', {}, `redirect:${href}`) }));

let root: Root;
let container: HTMLDivElement;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let originalActEnvironment: boolean | undefined;
beforeEach(() => {
  originalActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  state.sessions = [];
  state.maker.getSession.mockReset().mockResolvedValue(null);
  state.openLink.mockReset().mockResolvedValue(undefined);
  state.connectionEpoch = 0;
  state.accountGeneration = 1;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove(); state.listeners.clear();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

describe('mobile Cindy Make links', () => {
  it('resolves mirrored tasks whose source is missing before mounting the screen', async () => {
    state.sessions = [{ id: 'old-task', deviceLinkDeviceId: 'device-a' }];
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
    expect(state.maker.getSession).toHaveBeenCalledWith('old-task');
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toBe('Composer');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('redirects %s to Home before mounting the task screen', (source) => {
    state.sessions = [{ id: 'old-task', source }];
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it('waits for mirror metadata without mounting the task screen', () => {
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'cindy-make' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('redirect:/');
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'desktop' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('Composer');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('resolves a cold %s link directly without waiting for the list', async (source) => {
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(state.openLink).toHaveBeenCalledWith('device-a');
    expect(state.maker.getSession).toHaveBeenCalledWith('old-task');
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
    await act(async () => resolveSession({ id: 'old-task', source }));
    expect(state.sessions).toEqual([]);
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it.each(['desktop', undefined])('opens an ordinary cold link only after confirming source %s', async (source) => {
    state.maker.getSession.mockResolvedValue({ id: 'old-task', source });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
  });

  it.each([null, { id: 'another-task', source: 'desktop' }])('keeps unresolved or mismatched metadata closed: %s', async (session) => {
    state.maker.getSession.mockResolvedValue(session);
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
  });

  it('keeps a failed metadata lookup closed and retries after reconnecting', async () => {
    state.maker.getSession.mockRejectedValueOnce(new Error('metadata unavailable'));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    const gate = <CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>;
    await act(async () => root.render(gate));
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
    state.connectionEpoch += 1;
    state.maker.getSession.mockResolvedValue({ id: 'old-task', source: 'desktop' });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
    expect(state.maker.getSession).toHaveBeenCalledTimes(2);
  });

  it('ignores a late lookup after mirror metadata has identified a hidden task', async () => {
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'cindy-make', deviceLinkDeviceId: 'device-a' }];
      for (const listener of state.listeners) listener();
    });
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it('does not reuse confirmed metadata after switching tasks or accounts', async () => {
    state.maker.getSession.mockResolvedValueOnce({ id: 'old-task', source: 'desktop' });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
    state.accountGeneration += 1;
    state.maker.getSession.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    await act(async () => root.render(<CindyMakeSessionGate sessionId="next-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    expect(state.maker.getSession).toHaveBeenLastCalledWith('next-task');
  });

  it('does not use another device mirror or late response to unlock a switched route', async () => {
    state.sessions = [{ id: 'old-task', source: 'desktop', deviceLinkDeviceId: 'device-b' }];
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValueOnce(new Promise(resolve => { resolveSession = resolve; }))
      .mockReturnValueOnce(new Promise(() => {}));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('');
    await act(async () => root.render(<CindyMakeSessionGate sessionId="next-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toBe('');
    expect(Content).not.toHaveBeenCalled();
  });
});

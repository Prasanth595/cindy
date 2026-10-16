// @vitest-environment jsdom
import { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import { getTabKind, hydrateTabState } from '../../../registry';
import type { TerminalState } from '../index';
import '../index';

const { closeTab } = vi.hoisted(() => ({ closeTab: vi.fn() }));
vi.mock('../../../store', () => ({ closeTab }));

const fit = vi.fn();
const resize = vi.fn(async () => undefined);
const entry = {
  terminal: {
    cols: 80,
    rows: 24,
    element: undefined,
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    focus: vi.fn(),
  },
  fitAddon: { fit },
  lastSize: { cols: 80, rows: 24 },
  ptyAttached: true,
  exit: null as TerminalState['exited'],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('../lib/xtermPool', () => ({
  getOrCreateXterm: () => entry,
}));

import { TerminalTabBody } from '../TerminalTabBody';

class TestResizeObserver {
  static callback: ResizeObserverCallback | null = null;
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeContext(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'terminal-1',
    sessionId: 'session-1',
    workdir: '/workspace',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

beforeEach(() => {
  fit.mockClear();
  resize.mockClear();
  entry.terminal.open.mockClear();
  entry.terminal.onData.mockClear();
  entry.terminal.cols = 80;
  entry.terminal.rows = 24;
  entry.lastSize = { cols: 80, rows: 24 };
  entry.ptyAttached = true;
  entry.exit = null;
  closeTab.mockReset().mockResolvedValue(undefined);
  TestResizeObserver.callback = null;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        create: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
        resize,
        restart: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
        write: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      },
    },
  });
});

// Match the sidebar's real render path: hydrateState runs again after every patch.
function StatefulTerminal({ active = true, shellVisible = true } = {}) {
  const [raw, setRaw] = useState<TerminalState>({
    created: true, exited: null, title: '', shellId: 'zsh', shellDisplayName: 'zsh',
  });
  const patchState = useCallback((patch: unknown) => {
    setRaw((prev) => ({ ...prev, ...patch as Partial<TerminalState> }));
  }, []);
  return (
    <TerminalTabBody
      state={hydrateTabState(getTabKind('terminal'), raw) as TerminalState}
      ctx={makeContext({ patchState })}
      active={active}
      shellVisible={shellVisible}
    />
  );
}

function emitExit(exit: NonNullable<TerminalState['exited']>, id = 'terminal-1') {
  const listener = vi.mocked(window.electronAPI.terminal.onExit).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('terminal exit listener not registered');
  act(() => listener({ id, exit }));
}

describe('TerminalTabBody process exit', () => {
  it('does not recreate an attached PTY when sidebar hydration resets created', () => {
    render(<StatefulTerminal />);
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
  });

  it.each([null, '0'])('closes the terminal through the tab lifecycle on a clean exit (signal %s)', (signal) => {
    render(<StatefulTerminal />);
    emitExit({ code: 0, signal });
    expect(closeTab).toHaveBeenCalledWith('session-1', 'terminal-1');
  });

  it('closes a background terminal even while the sidebar is collapsed', () => {
    render(<StatefulTerminal active={false} shellVisible={false} />);
    emitExit({ code: 0, signal: null });
    expect(closeTab).toHaveBeenCalledWith('session-1', 'terminal-1');
  });

  it.each([
    { code: 1, signal: null },
    { code: 1, signal: '0' },
    { code: null, signal: null },
    { code: 0, signal: '15' },
  ])('keeps abnormal or unknown exits visible after sidebar state hydration: %j', (exit) => {
    render(<StatefulTerminal />);
    emitExit(exit);
    expect(closeTab).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' })).toBeTruthy();
    expect(screen.getByText(exit.signal && exit.signal !== '0'
      ? 'rightSidebar.terminal.processKilled'
      : 'rightSidebar.terminal.processExited')).toBeTruthy();
  });

  it('ignores exit events for another terminal and unsubscribes on unmount', () => {
    const view = render(<StatefulTerminal />);
    emitExit({ code: 0, signal: null }, 'terminal-2');
    expect(closeTab).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.mocked(window.electronAPI.terminal.onExit).mock.results[0].value).toHaveBeenCalled();
    emitExit({ code: 0, signal: null });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('preserves an abnormal exit across remounts without reattaching the exited PTY', () => {
    const view = render(<StatefulTerminal />);
    emitExit({ code: 2, signal: null });
    view.unmount();
    vi.mocked(window.electronAPI.terminal.create).mockClear();
    render(<StatefulTerminal />);
    expect(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' })).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
  });

  it('clears the exit snapshot when the user restarts the shell', async () => {
    render(<StatefulTerminal />);
    emitExit({ code: 2, signal: null });
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' }));
    await waitFor(() => expect(window.electronAPI.terminal.restart).toHaveBeenCalledWith('terminal-1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'rightSidebar.terminal.restart' })).toBeNull());
    emitExit({ code: 0, signal: null });
    expect(closeTab).toHaveBeenCalledWith('session-1', 'terminal-1');
  });

  it('preserves a new abnormal exit that arrives before the restart reply', async () => {
    let resolveRestart!: (value: { shellId: 'zsh'; shellDisplayName: string; pid: number }) => void;
    vi.mocked(window.electronAPI.terminal.restart).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRestart = resolve;
    }));
    render(<StatefulTerminal />);
    emitExit({ code: 2, signal: null });
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' }));
    emitExit({ code: 3, signal: null });
    await act(async () => resolveRestart({ shellId: 'zsh', shellDisplayName: 'zsh', pid: 123 }));
    expect(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' })).toBeTruthy();
    expect(entry.exit).toEqual({ code: 3, signal: null });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('keeps the exit overlay available if closing the tab fails', async () => {
    closeTab.mockRejectedValueOnce(new Error('close failed'));
    render(<StatefulTerminal />);
    emitExit({ code: 0, signal: null });
    await waitFor(() => expect(closeTab).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' })).toBeTruthy();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalTabBody sidebar visibility', () => {
  it('does not fit or resize the PTY while the sidebar is collapsed, then refits when visible', () => {
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );

    TestResizeObserver.callback?.([], {} as ResizeObserver);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    entry.terminal.cols = 100;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    expect(fit).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith('terminal-1', 100, 24);
  });

  it('drops an already queued fit when the sidebar collapses before its animation frame', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    entry.terminal.cols = 2;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );
    frame?.(0);

    expect(resize).not.toHaveBeenCalled();
  });
});

describe('TerminalTabBody remote ownership', () => {
  it('continues to create a PTY for a confirmed local session', async () => {
    entry.ptyAttached = false;
    render(
      <TerminalTabBody
        state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={makeContext()}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', cwd: '/workspace' }),
    ));
  });

  it('creates the local PTY after device-link ownership resolves from unknown to local', async () => {
    entry.ptyAttached = false;
    const unresolvedContext = makeContext({ deviceLinkDeviceId: undefined });
    const state = { created: false, exited: null, title: '', shellId: '', shellDisplayName: '' };
    const view = render(<TerminalTabBody state={state} ctx={unresolvedContext} active />);

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();

    view.rerender(
      <TerminalTabBody
        state={state}
        ctx={{ ...unresolvedContext, deviceLinkDeviceId: null }}
        active
      />,
    );

    await waitFor(() => expect(window.electronAPI.terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', cwd: '/workspace' }),
    ));
    expect(screen.queryByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeNull();
  });

  it.each([
    ['an SSH session', { remoteHostId: 'ssh-host-1', deviceLinkDeviceId: null }],
    ['a device-link session', { remoteHostId: null, deviceLinkDeviceId: 'device-1' }],
    ['unresolved device-link ownership', { remoteHostId: null, deviceLinkDeviceId: undefined }],
  ])('fails closed for %s without creating a local PTY', (_label, ownership) => {
    const ctx = makeContext(ownership);
    render(
      <TerminalTabBody
        state={{ created: false, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
      />,
    );

    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableTitle')).toBeTruthy();
    expect(screen.getByText('rightSidebar.terminal.remoteUnavailableDescription')).toBeTruthy();
    expect(window.electronAPI.terminal.create).not.toHaveBeenCalled();
    expect(entry.terminal.open).not.toHaveBeenCalled();
  });
});

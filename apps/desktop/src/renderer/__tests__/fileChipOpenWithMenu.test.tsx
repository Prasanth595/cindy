// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAbsPath: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  openPath: vi.fn(),
  error: vi.fn(),
  context: {
    sessionId: undefined as string | undefined,
    workingDir: '/repo',
    origin: { kind: 'local' } as { kind: string; deviceId?: string },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({
  useChatSessionFile: () => mocks.context,
}));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarTargetSessionId: (id: string | undefined) => id,
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(),
  pathToFileUrl: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(),
  openExternalFileInSidebarFileBrowser: vi.fn(),
  openFileInSidebarFileBrowser: vi.fn(),
}));
vi.mock('@/lib/remoteFileOpen', () => ({
  copyRemoteChatFile: vi.fn(),
  revealRemoteChatFile: vi.fn(),
}));

import { useFileChipContextMenu } from '../components/chat/useFileChipContextMenu';

function Fixture() {
  const { onContextMenu, menu } = useFileChipContextMenu({ getAbsPath: mocks.getAbsPath });
  return (
    <>
      <button onContextMenu={onContextMenu}>README.md</button>
      {menu}
    </>
  );
}
function openRoot() {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'README.md' }), {
    clientX: 10,
    clientY: 10,
  });
}
async function requestSub() {
  const trigger = await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.openWith' });
  act(() => trigger.focus());
  await act(async () => {
    fireEvent.keyDown(trigger, { key: 'ArrowRight', code: 'ArrowRight' });
  });
}
async function openSub() {
  await requestSub();
  await screen.findByRole('menuitem', { name: 'chat.media.openWithApp' });
}
function closeRoot() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.origin = { kind: 'local' };
  mocks.getAbsPath.mockResolvedValue('/repo/README.md');
  mocks.list.mockResolvedValue({
    success: true,
    apps: [
      { id: 'vscode', label: 'Visual Studio Code', iconDataUrl: 'data:image/png;base64,test' },
      { id: 'typora', label: 'Typora' },
    ],
  });
  mocks.open.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      listOpenWithApps: mocks.list,
      openFileWithApp: mocks.open,
      openPath: mocks.openPath,
    },
  });
});
afterEach(cleanup);

describe('file chip open-with submenu', () => {
  it('prefetches on right click, preserves main ordering and opens by application id without changing left click', async () => {
    render(<Fixture />);
    expect(mocks.list).not.toHaveBeenCalled();
    openRoot();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    await openSub();
    await screen.findByRole('menuitem', { name: 'Visual Studio Code' });
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(names.indexOf('Visual Studio Code')).toBeLessThan(names.indexOf('Typora'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Visual Studio Code' }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({ filePath: '/repo/README.md', appId: 'vscode' }),
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it('reveals default and local applications together instead of inserting local rows later', async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Fixture />);
    openRoot();
    await requestSub();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    expect(screen.queryByRole('menuitem', { name: 'chat.media.openWithApp' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Visual Studio Code' })).toBeNull();
    await act(async () => {
      finish({ success: true, apps: [{ id: 'vscode', label: 'Visual Studio Code' }] });
    });
    expect(screen.getByRole('menuitem', { name: 'chat.media.openWithApp' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Visual Studio Code' })).toBeTruthy();
  });

  it('refreshes an old prefetch if the user waits in the root menu', async () => {
    const clock = vi.spyOn(Date, 'now');
    const startedAt = Date.now();
    try {
      render(<Fixture />);
      openRoot();
      await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
      await act(async () => {});
      mocks.list.mockResolvedValueOnce({
        success: true,
        apps: [{ id: 'new', label: 'New Editor' }],
      });
      clock.mockReturnValue(startedAt + 2000);
      await openSub();
      expect(screen.getByRole('menuitem', { name: 'New Editor' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'Visual Studio Code' })).toBeNull();
      expect(mocks.list).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('reuses a slow pending prefetch instead of starting a duplicate Windows scan', async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const clock = vi.spyOn(Date, 'now');
    const startedAt = Date.now();
    try {
      render(<Fixture />);
      openRoot();
      await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
      clock.mockReturnValue(startedAt + 2000);
      await requestSub();
      expect(mocks.list).toHaveBeenCalledOnce();
      await act(async () => {
        finish({ success: true, apps: [{ id: 'vscode', label: 'Visual Studio Code' }] });
      });
      expect(screen.getByRole('menuitem', { name: 'Visual Studio Code' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'chat.media.openWithApp' })).toBeTruthy();
    } finally { clock.mockRestore(); }
  });

  it.each(['pointerLeave', 'blur'] as const)(
    'does not pop open after %s during a pending query',
    async (event) => {
      let finish!: (value: unknown) => void;
      mocks.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(<Fixture />);
      openRoot();
      await requestSub();
      const trigger = screen.getByRole('menuitem', { name: 'chat.markdownRenderer.openWith' });
      fireEvent[event](trigger);
      await act(async () => {
        finish({ success: true, apps: [{ id: 'vscode', label: 'Visual Studio Code' }] });
      });
      expect(screen.queryByRole('menuitem', { name: 'chat.media.openWithApp' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Visual Studio Code' })).toBeNull();
    },
  );

  it('refreshes applications when reopening the submenu', async () => {
    render(<Fixture />);
    openRoot();
    await openSub();
    await screen.findByRole('menuitem', { name: 'Visual Studio Code' });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Typora' }), {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
    });
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'Visual Studio Code' })).toBeNull(),
    );
    mocks.list.mockResolvedValueOnce({
      success: true,
      apps: [{ id: 'obsidian', label: 'Obsidian' }],
    });
    await openSub();
    await screen.findByRole('menuitem', { name: 'Obsidian' });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('menuitem', { name: 'Visual Studio Code' })).toBeNull();
  });

  it('keeps the default application available if querying fails', async () => {
    mocks.list.mockRejectedValueOnce(new Error('native query failed'));
    render(<Fixture />);
    openRoot();
    await openSub();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.media.openWithApp' }));
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/repo/README.md'));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not restore a stale response after closing and reopening', async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Fixture />);
    openRoot();
    await requestSub();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    closeRoot();
    closeRoot();
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'chat.markdownRenderer.openWith' })).toBeNull(),
    );
    openRoot();
    await openSub();
    await screen.findByRole('menuitem', { name: 'Visual Studio Code' });
    await act(async () => {
      finish({ success: true, apps: [{ id: 'old', label: 'Uninstalled App' }] });
    });
    expect(screen.queryByRole('menuitem', { name: 'Uninstalled App' })).toBeNull();
  });

  it('does not add a host application list to remote-file menus', () => {
    mocks.context.origin = { kind: 'device', deviceId: 'remote' };
    render(<Fixture />);
    openRoot();
    expect(screen.queryByRole('menuitem', { name: 'chat.markdownRenderer.openWith' })).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

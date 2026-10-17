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
    origin: { kind: 'local' } as { kind: string; deviceId?: string; remoteHostId?: string },
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
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(),
  openExternalFileInSidebarFileBrowser: vi.fn(),
  openFileInSidebarFileBrowser: vi.fn(),
}));
vi.mock('@/lib/remoteFileOpen', () => ({
  copyRemoteChatFile: vi.fn(),
  downloadRemoteChatEntry: vi.fn(),
  openRemoteChatFile: vi.fn(),
}));
vi.mock('@/components/chat/useOpenWithMenu', () => ({ openHtmlFileByPreference: vi.fn() }));
import { useFileChipContextMenu } from '../components/chat/useFileChipContextMenu';

const TITLE = 'chat.markdownRenderer.appPicker.title';
const OPEN = 'chat.markdownRenderer.appPicker.open';
function Fixture({
  name = 'README.md',
  html = false,
  directory = false,
  resolve = mocks.getAbsPath,
} = {}) {
  const { onContextMenu, menu } = useFileChipContextMenu({
    fileName: name,
    getAbsPath: resolve,
    canOpenInBrowser: html,
    sidebarFileBrowserKind: directory ? 'directory' : 'file',
  });
  return (
    <>
      <button onContextMenu={onContextMenu}>{name}</button>
      {menu}
    </>
  );
}
function openRoot(name = 'README.md') {
  fireEvent.contextMenu(screen.getByRole('button', { name }), { clientX: 10, clientY: 10 });
}
function requestApps() {
  fireEvent.click(screen.getByRole('menuitem', { name: TITLE }));
}
async function picker() {
  requestApps();
  return screen.findByRole('alertdialog');
}
function escape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.origin = { kind: 'local' };
  mocks.getAbsPath.mockResolvedValue('/repo/README.md');
  mocks.list.mockResolvedValue({
    success: true,
    apps: [
      { id: 'code', label: 'Visual Studio Code' },
      { id: 'typora', label: 'Typora' },
    ],
  });
  mocks.open.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      listOpenWithApps: mocks.list,
      openFileWithApp: mocks.open,
      openPath: mocks.openPath,
    },
  });
});
afterEach(cleanup);

describe('flat file menu and application picker', () => {
  it('keeps the default action immediate, resolves lazily, and only opens after explicit choice', async () => {
    render(<Fixture />);
    openRoot();
    expect(screen.getByRole('menuitem', { name: /chat.media.openWithApp/ })).toBeTruthy();
    expect(mocks.getAbsPath).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    await picker();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
    expect((screen.getByRole('button', { name: OPEN }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } });
    expect(screen.queryByRole('radio', { name: 'Typora' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Visual Studio Code' }));
    fireEvent.click(screen.getByRole('button', { name: OPEN }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({ filePath: '/repo/README.md', appId: 'code' }),
    );
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
  it('does not query twice or show an incomplete application group while discovery is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Fixture />);
    openRoot();
    requestApps();
    requestApps();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /chat.media.openWithApp/ })).toBeTruthy();
    await act(async () =>
      finish({ success: true, apps: [{ id: 'code', label: 'Visual Studio Code' }] }),
    );
    expect(screen.getByRole('radio', { name: 'Visual Studio Code' })).toBeTruthy();
  });
  it.each(['escape', 'file change', 'unmount'])(
    'discards pending results after %s',
    async (mode) => {
      let finish!: (value: unknown) => void;
      mocks.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = render(<Fixture />);
      openRoot();
      requestApps();
      await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
      if (mode === 'escape') escape();
      if (mode === 'file change') view.rerender(<Fixture name="other.md" />);
      if (mode === 'unmount') view.unmount();
      await act(async () => finish({ success: true, apps: [{ id: 'old', label: 'Old app' }] }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );
  it.each(['ssh', 'device'])(
    'does not resolve or scan local applications for a %s source',
    (kind) => {
      mocks.context.origin = { kind, deviceId: 'remote', remoteHostId: 'ssh-host' };
      render(<Fixture />);
      openRoot();
      expect(screen.queryByRole('menuitem', { name: TITLE })).toBeNull();
      expect(mocks.getAbsPath).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
  it.each(['html', 'directory', 'linux'])('does not add an app picker to %s', (kind) => {
    if (kind === 'linux') window.electronAPI.platform = 'linux';
    render(<Fixture html={kind === 'html'} directory={kind === 'directory'} />);
    openRoot();
    expect(screen.queryByRole('menuitem', { name: TITLE })).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('keeps default opening available when discovery fails and allows an explicit retry', async () => {
    mocks.list.mockResolvedValueOnce({ success: false, apps: [] });
    render(<Fixture />);
    openRoot();
    requestApps();
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(screen.getByRole('menuitem', { name: /chat.media.openWithApp/ })).toBeTruthy();
    await picker();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  it('shows an honest empty state, does not select anything automatically and restores chip focus on cancel', async () => {
    mocks.list.mockResolvedValueOnce({ success: true, apps: [] });
    render(<Fixture />);
    openRoot();
    await picker();
    expect(screen.getByText('chat.markdownRenderer.appPicker.empty')).toBeTruthy();
    expect((screen.getByRole('button', { name: OPEN }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'chat.markdownRenderer.appPicker.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'README.md' }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('refuses a same-name chip whose resolved file changed after choosing an app', async () => {
    render(<Fixture />);
    openRoot();
    await picker();
    mocks.getAbsPath.mockResolvedValue('/other/README.md');
    fireEvent.click(screen.getByRole('radio', { name: 'Typora' }));
    fireEvent.click(screen.getByRole('button', { name: OPEN }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('chat.markdownRenderer.appPicker.changed'),
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  'uses resolved file identity across a parent rerender (same file: %s)',
  async (sameFile) => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Fixture />);
    openRoot();
    requestApps();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    view.rerender(
      <Fixture resolve={vi.fn(async () => (sameFile ? '/repo/README.md' : '/other/README.md'))} />,
    );
    await act(async () =>
      finish({ success: true, apps: [{ id: 'code', label: 'Visual Studio Code' }] }),
    );
    if (sameFile) expect(screen.getByRole('alertdialog')).toBeTruthy();
    else expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  },
);

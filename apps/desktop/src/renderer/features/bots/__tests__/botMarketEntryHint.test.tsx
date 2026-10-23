// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotCreateMenu } from '../BotCreateMenu';
import { resetBotMarketEntryHintForTest, useBotMarketEntryHint } from '../botMarketEntryHint';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';

vi.mock('../BotRosterView', () => ({ BotRosterView: () => null }));
vi.mock('../BotGroupCreateDialog', () => ({ BotGroupCreateDialog: () => null }));
vi.mock('../BotMarketDialog', () => ({ BotMarketDialog: () => null }));
vi.mock('../ChatInviteDialog', () => ({ ChatInviteDialog: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}));

const STORAGE_KEY = sidebarOwnerStorageKey('sidebar.botMarketEntryHint.v1', 'owner-a');
const PLAIN = 'bots.list.createMenu';
const WITH_HINT = 'bots.list.createMenu · sidebar.navigation.new';

function Harness({ owner = 'owner-a' }: { owner?: string | null }) {
  const hint = useBotMarketEntryHint(owner);
  return (
    <MemoryRouter>
      <BotCreateMenu variant="header" entryHint={hint} />
    </MemoryRouter>
  );
}

const openMenu = (name: string) => fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' });
const hasDot = (button: HTMLElement) => button.querySelector('span[aria-hidden]') !== null;

beforeEach(() => {
  window.localStorage.clear();
  resetBotMarketEntryHintForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('bot market entry hint on the teammates "+"', () => {
  it('marks the trigger with a dot and a "new" label until it is first opened', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: WITH_HINT });
    expect(hasDot(trigger)).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('drops the dot and persists as soon as the menu opens, but keeps the item tag until it closes', () => {
    render(<Harness />);
    openMenu(WITH_HINT);

    const trigger = screen.getByRole('button', { name: PLAIN, hidden: true });
    expect(hasDot(trigger)).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    const item = screen.getByRole('menuitem', { name: /bots\.market\.heading/ });
    expect(item.textContent).toContain('sidebar.navigation.new');

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    openMenu(PLAIN);
    expect(screen.getByRole('menuitem', { name: /bots\.market\.heading/ }).textContent)
      .not.toContain('sidebar.navigation.new');
  });

  it('stays quiet in a fresh window once the account has seen it', () => {
    render(<Harness />);
    openMenu(WITH_HINT);
    cleanup();
    resetBotMarketEntryHintForTest();

    render(<Harness />);
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
  });

  it('treats unreadable storage as already seen', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    render(<Harness />);
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
  });

  it('does not nag again in this run when the mark cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { unmount } = render(<Harness />);
    openMenu(WITH_HINT);
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
    unmount();

    render(<Harness />);
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
  });

  it('drops the dot when another window of the same account marks it seen', () => {
    render(<Harness />);
    expect(hasDot(screen.getByRole('button', { name: WITH_HINT }))).toBe(true);
    act(() => {
      window.localStorage.setItem(STORAGE_KEY, 'seen');
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    });
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
  });

  it('keeps the signed-out state silent and re-checks when the account changes', () => {
    const view = render(<Harness owner={null} />);
    expect(hasDot(screen.getByRole('button', { name: PLAIN, hidden: true }))).toBe(false);
    act(() => view.rerender(<Harness owner="owner-a" />));
    expect(hasDot(screen.getByRole('button', { name: WITH_HINT }))).toBe(true);
  });
});
